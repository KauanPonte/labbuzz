// server.js
import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';

/* ===== CONFIG ===== */
const PORT = process.env.PORT || 3000;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.emqx.io:1883';
const FIXED_PAYLOAD = 'ms=3000';          // 3 segundos fixos
const ONLINE_THRESHOLD_MS = Number(process.env.ONLINE_THRESHOLD_MS) || 90_000; // 90s
const ADMIN_PWD = process.env.ADMIN_PASSWORD || '123456';

/* ===== HELPERS ===== */
const now = () => Date.now();
function sanitizeLab(raw) {
  if (!raw && raw !== '') return null;
  const lab = String(raw || '').toUpperCase().trim();
  if (!/^[A-Z0-9_-]{3,20}$/.test(lab)) return null;
  return lab;
}

/* ===== LOAD LABS FROM ENV ===== */
function loadLabsFromEnv() {
  const raw = process.env.LABS || 'LAPADA';
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const set = new Set();
  for (const p of parts) {
    const ok = sanitizeLab(p);
    if (ok) set.add(ok);
    else console.warn(`[WARN] LAB ignorado por nome inválido: "${p}"`);
  }
  if (set.size === 0) {
    set.add('LAPADA');
    console.warn('[WARN] Nenhum LAB válido no .env; usando fallback ["LAPADA"].');
  }
  return set;
}

/* ===== PERSISTED OVERRIDES ===== */
const OVERRIDE_FILE = path.join(process.cwd(), 'lab_status.json');
function loadOverrides() {
  try {
    if (!fs.existsSync(OVERRIDE_FILE)) return {};
    const raw = fs.readFileSync(OVERRIDE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return {};
    return obj;
  } catch (e) {
    console.error('[WARN] falha ao ler overrides:', e.message);
    return {};
  }
}
function saveOverrides(obj) {
  try {
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[ERROR] falha ao salvar overrides:', e.message);
  }
}

/* ===== STATE ===== */
const labs = loadLabsFromEnv();
const lastRing = new Map();
const lastSeen = new Map();
const sessions = new Map();
const ipHits = new Map();
let overrides = loadOverrides();

/* ===== SESSIONS ===== */
function newSession(ip) {
  const token = crypto.randomUUID();
  sessions.set(token, { ip, exp: now() + 60 * 60 * 1000 }); // 1h
  return token;
}
function validateToken(reqToken, ip) {
  const s = sessions.get(reqToken);
  if (!s) return false;
  if (s.ip !== ip) return false;
  if (s.exp < now()) { sessions.delete(reqToken); return false; }
  return true;
}

/* ===== MQTT ===== */
const mqttClient = mqtt.connect(MQTT_URL);
mqttClient.on('connect', () => {
  console.log('[MQTT] conectado:', MQTT_URL);
  mqttClient.subscribe('lab/+/alive', { qos: 1 }, (err) => {
    if (err) console.error('[MQTT] falha ao subscrever alive:', err.message);
    else console.log('[MQTT] subscrito em lab/+/alive');
  });
});
mqttClient.on('error', (e) => console.error('[MQTT] erro:', e.message));
mqttClient.on('message', (topic, payload) => {
  try {
    const m = topic.match(/^lab\/([^/]+)\/alive$/);
    if (!m) return;
    const labId = sanitizeLab(m[1]);
    if (!labId) return;
    lastSeen.set(labId, Date.now());
  } catch (err) {
    console.error('[MQTT] erro ao processar message:', err);
  }
});

/* ===== EXPRESS APP ===== */
const app = express();
app.use(express.json());
app.use(express.static('public'));

/* rate/cooldown middlewares */
function rateLimit(req, res, next) {
  const key = req.ip;
  const win = 10_000;
  const max = 8;
  const rec = ipHits.get(key) || { n: 0, t: now() };
  if (now() - rec.t > win) { rec.n = 0; rec.t = now(); }
  rec.n++; ipHits.set(key, rec);
  if (rec.n > max) return res.status(429).json({ ok: false, error: "Muitos cliques. Aguarde um pouco." });
  next();
}
function cooldown(req, res, next) {
  const lab = req.body?.lab;
  const last = lastRing.get(lab) || 0;
  const CD = 3000;
  if (now() - last < CD) return res.status(429).json({ ok: false, error: "Campainha em cooldown." });
  next();
}

/* compute effective online considering override */
function computeEffectiveOnline(labId) {
  const ov = overrides[labId];
  if (ov === 'online') return true;
  if (ov === 'offline') return false;
  const seen = lastSeen.get(labId) || 0;
  return (now() - seen) <= ONLINE_THRESHOLD_MS;
}

/* ===== ENDPOINTS ===== */
app.get('/api/bootstrap', (req, res) => {
  const token = newSession(req.ip);
  const arr = [...labs].sort().map(id => {
    const seen = lastSeen.get(id) || 0;
    const autoOnline = (now() - seen) <= ONLINE_THRESHOLD_MS;
    const ov = overrides[id] || null;
    const effective = computeEffectiveOnline(id);
    return { id, name: id, logo: `/logos/${id}.png`, online: effective, overridden: !!ov, overrideValue: ov, autoOnline };
  });
  res.json({ labs: arr, token });
});

app.post('/api/ring', rateLimit, cooldown, (req, res) => {
  const { lab, token } = req.body || {};
  const labId = sanitizeLab(lab);
  if (!labId || !labs.has(labId)) return res.status(400).json({ ok: false, error: 'Laboratório inválido.' });
  if (!validateToken(token, req.ip)) return res.status(403).json({ ok: false, error: 'Token inválido ou expirado.' });

  const topic = `lab/${labId}/ring`;
  mqttClient.publish(topic, FIXED_PAYLOAD, { qos: 1 }, (err) => {
    if (err) return res.status(500).json({ ok: false, error: 'Falha ao publicar MQTT' });
    lastRing.set(labId, now());
    res.json({ ok: true, topic, payload: FIXED_PAYLOAD });
  });
});

app.post('/api/lab-status', (req, res) => {
  const { lab, status, action, adminPwd } = req.body || {};
  if (adminPwd !== ADMIN_PWD) return res.status(401).json({ ok: false, error: 'Senha administrativa inválida.' });
  const labId = sanitizeLab(lab);
  if (!labId || !labs.has(labId)) return res.status(400).json({ ok: false, error: 'Laboratório inválido.' });

  if (action === 'clear') {
    if (overrides[labId]) { delete overrides[labId]; saveOverrides(overrides); return res.json({ ok: true, lab: labId, overridden: false }); }
    else return res.json({ ok: true, lab: labId, overridden: false, note: 'não havia override' });
  }

  if (status === 'online' || status === 'offline') { overrides[labId] = status; saveOverrides(overrides); return res.json({ ok: true, lab: labId, overridden: true, overrideValue: status }); }

  return res.status(400).json({ ok: false, error: 'Requisição inválida. Use {lab,status:"online"} ou {lab,action:"clear"} com adminPwd.' });
});

app.get('/api/lab-status', (req, res) => {
  const adminPwd = req.query.adminPwd;
  if (adminPwd !== ADMIN_PWD) return res.status(401).json({ ok: false, error: 'Senha administrativa inválida.' });
  res.json({ ok: true, overrides });
});

app.all('/api/labs', (_req, res) => {
  res.status(410).json({ ok: false, error: 'Gestão de labs desativada. Use .env LABS.' });
});

/* ===== CLIENT JS (servido dinamicamente em /js/app.js) ===== */
const CLIENT_JS = `
(() => {
  'use strict';

  const grid = document.getElementById('grid');
  const toast = document.getElementById('toast');
  const COOLDOWN_MS = 3000;
  const cool = new Map();
  let token = null;

  const showToast = (msg, ok = true) => {
    if (!toast) return;
    toast.textContent = msg;
    toast.style.background = ok ? '#10b981' : '#ef4444';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1500);
  };

  const labIdOf = (item) => typeof item === 'string' ? item.toUpperCase() : (item.id || item.code || item.name || '').toUpperCase();
  const initialsOf = (name) => (name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\\s+/).slice(0, 2).map(s => s[0]?.toUpperCase() || '').join('') || 'LB';
  const labLogoOf = (item) => (typeof item === 'object' && item.logo) ? item.logo : \`/logos/\${labIdOf(item)}.png\`;

  function renderLabs(labs) {
    if (!grid) return;
    const html = (labs || []).map(l => {
      const id = typeof l === 'string' ? l : (l.id || l.name || '');
      const name = typeof l === 'string' ? l : (l.name || id);
      const online = typeof l === 'string' ? true : Boolean(l.online);
      const logo = labLogoOf({ id });
      const initials = initialsOf(name);
      return \`
        <button class="lab-card \${online ? '' : 'offline'}" data-id="\${id}" data-name="\${name}" aria-label="Tocar campainha de \${name}">
          <div class="logo-plate" aria-hidden="true">
            <div class="logo-inner">
              <img src="\${logo}" alt="Logo \${name}" loading="lazy" onerror="this.style.display='none'">
              <div class="initials">\${initials}</div>
            </div>
          </div>
          <div class="mini-card">\${name.toUpperCase()}</div>
          <div class="lab-name" aria-hidden="true">\${name.toUpperCase()}</div>
        </button>
      \`;
    }).join('');
    grid.innerHTML = html;

    document.querySelectorAll('.logo-inner img').forEach(img => {
      img.addEventListener('load', () => {
        const initials = img.parentElement.querySelector('.initials');
        if (initials) initials.style.opacity = '0';
      });
      img.addEventListener('error', () => { });
      if (img.complete && img.naturalWidth > 0) {
        const initials = img.parentElement.querySelector('.initials');
        if (initials) initials.style.opacity = '0';
      }
    });
  }

  async function bootstrap() {
    try {
      const r = await fetch('/api/bootstrap');
      const j = await r.json();
      token = j.token;
      const labs = (j.labs || []).map(l => typeof l === 'string' ? { id: l, name: l } : l);
      const qs = new URLSearchParams(location.search);
      const pre = (qs.get('lab') || '').toUpperCase();
      if (pre) labs.sort((a, b) => (labIdOf(a) === pre ? -1 : labIdOf(b) === pre ? 1 : 0));
      renderLabs(labs);
    } catch (e) {
      console.error(e);
      if (grid) grid.innerHTML = \`<p style="grid-column:1/-1;color:#b91c1c;text-align:center">Erro ao carregar laboratórios.</p>\`;
    }
  }

  async function ringLab(labId, labName, el) {
    const nowTs = Date.now(); const until = cool.get(labId) || 0;
    if (nowTs < until) {
      el.classList.add('err');
      if (navigator.vibrate) navigator.vibrate([10, 70, 20]);
      showToast('Campainha em cooldown, aguarde um pouco.', false);
      setTimeout(() => el.classList.remove('err'), 900);
      return;
    }

    el.classList.add('busy'); el.blur();
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch('/api/ring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lab: labId, token }),
        signal: ctrl.signal
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        el.classList.add('ok');
        if (navigator.vibrate) navigator.vibrate(25);
        showToast('Campainha enviada', true);
        cool.set(labId, Date.now() + COOLDOWN_MS);
        setTimeout(() => el.classList.remove('ok'), 900);
      } else {
        el.classList.add('err');
        if (navigator.vibrate) navigator.vibrate([10, 70, 20]);
        showToast(j.error || 'Falha ao tocar', false);
        setTimeout(() => el.classList.remove('err'), 900);
      }
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      el.classList.add('err');
      if (navigator.vibrate) navigator.vibrate([10, 70, 20]);
      showToast(aborted ? 'Tempo esgotado' : 'Erro de rede', false);
      setTimeout(() => el.classList.remove('err'), 900);
    } finally {
      clearTimeout(t);
      el.classList.remove('busy');
    }
  }

   if (typeof document !== 'undefined') {
    document.addEventListener('click', ev => {
      const btn = ev.target.closest ? ev.target.closest('.lab-card') : null;
      if (!btn) return;

      // 🔻 Lab OFFLINE: pisca borda vermelha e mostra aviso
      if (btn.classList.contains('offline')) {
       const id = btn.dataset.id;
       const name = btn.dataset.name || id;
       btn.classList.add('err');
       showToast('Laboratório ' + name + ' está offline.', false);
       setTimeout(() => btn.classList.remove('err'), 900);
       return;
      }

      const id = btn.dataset.id;
      const name = btn.dataset.name || id;
      ringLab(id, name, btn);
    });

    window.addEventListener('resize', () => { });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
      bootstrap();
    }
  }

})();`;

/* rota que entrega o JS do cliente */
app.get('/js/app.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(CLIENT_JS);
});

/* ===== START SERVER ===== */
app.listen(PORT, () => {
  console.log(`[HTTP] http://localhost:${PORT}`);
  console.log(`[INFO] Labs ativos: ${[...labs].join(', ')}`);
  console.log(`[INFO] ONLINE_THRESHOLD_MS = ${ONLINE_THRESHOLD_MS} ms`);
});
