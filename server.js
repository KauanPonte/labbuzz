// server.js
// Versão: adiciona "status override" persistente controlado por ADMIN_PASSWORD
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
// shape on disk: { "LAB01": "online", "LAB02": "offline" }
// meaning: when key exists, it forces the effective state to that value
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
const labs = loadLabsFromEnv();              // Set of lab IDs
const lastRing = new Map();                 // lab -> timestamp (cooldown)
const lastSeen = new Map();                 // lab -> timestamp last alive seen
const sessions = new Map();                 // token -> { ip, exp }
const ipHits = new Map();
let overrides = loadOverrides();             // plain object { LAB: 'online'|'offline' }

/* ===== SESSION HELPERS ===== */
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
    // subscreve alive para detectar online automaticamente
    mqttClient.subscribe('lab/+/alive', { qos: 1 }, (err) => {
        if (err) console.error('[MQTT] falha ao subscrever alive:', err.message);
        else console.log('[MQTT] subscrito em lab/+/alive');
    });
});
mqttClient.on('error', (e) => console.error('[MQTT] erro:', e.message));
mqttClient.on('message', (topic, payload) => {
    // Ex.: topic = lab/LAB02/alive
    try {
        const m = topic.match(/^lab\/([^/]+)\/alive$/);
        if (!m) return;
        const labId = sanitizeLab(m[1]);
        if (!labId) return;
        lastSeen.set(labId, Date.now());
        // se não houver override forçando offline, NÃO alteramos override automaticamente;
        // overrides persistem até que você limpe eles manualmente.
        // (automatic online detection apenas afeta effective state when no override)
        // console.log(`[MQTT] alive ${labId}`);
    } catch (err) {
        console.error('[MQTT] erro ao processar message:', err);
    }
});

/* ===== EXPRESS APP ===== */
const app = express();
app.use(express.json());
app.use(express.static('public'));

/* middlewares rate/cooldown (mantidos) */
function rateLimit(req, res, next) {
    const key = req.ip;
    const win = 10_000;  // 10 s
    const max = 8;       // máx 8 toques por IP / 10s
    const rec = ipHits.get(key) || { n: 0, t: now() };
    if (now() - rec.t > win) { rec.n = 0; rec.t = now(); }
    rec.n++; ipHits.set(key, rec);
    if (rec.n > max) return res.status(429).json({ ok: false, error: "Muitos cliques. Aguarde um pouco." });
    next();
}
function cooldown(req, res, next) {
    const lab = req.body?.lab;
    const last = lastRing.get(lab) || 0;
    const CD = 3000; // 3 s por laboratório
    if (now() - last < CD) return res.status(429).json({ ok: false, error: "Campainha em cooldown." });
    next();
}

/* utility: compute effective online considering override */
function computeEffectiveOnline(labId) {
    // if override exists, that wins and persists until cleared
    const ov = overrides[labId];
    if (ov === 'online') return true;
    if (ov === 'offline') return false;
    // otherwise use automatic alive detection
    const seen = lastSeen.get(labId) || 0;
    return (now() - seen) <= ONLINE_THRESHOLD_MS;
}

/* ===== Endpoints ===== */

/* bootstrap: returns labs as objects with online + override info */
app.get('/api/bootstrap', (req, res) => {
    const token = newSession(req.ip);
    const arr = [...labs].sort().map(id => {
        const seen = lastSeen.get(id) || 0;
        const autoOnline = (now() - seen) <= ONLINE_THRESHOLD_MS;
        const ov = overrides[id] || null; // 'online' | 'offline' | null
        const effective = computeEffectiveOnline(id);
        return { id, name: id, logo: `/logos/${id}.png`, online: effective, overridden: !!ov, overrideValue: ov, autoOnline };
    });
    res.json({ labs: arr, token });
});

/* ring: publishes MQTT ring */
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
        if (overrides[labId]) {
            delete overrides[labId];
            saveOverrides(overrides);
            return res.json({ ok: true, lab: labId, overridden: false });
        } else {
            return res.json({ ok: true, lab: labId, overridden: false, note: 'não havia override' });
        }
    }

    if (status === 'online' || status === 'offline') {
        overrides[labId] = status;
        saveOverrides(overrides);
        return res.json({ ok: true, lab: labId, overridden: true, overrideValue: status });
    }

    return res.status(400).json({ ok: false, error: 'Requisição inválida. Use {lab,status:\"online\"} ou {lab,action:\"clear\"} com adminPwd.' });
});

/* optional: read-only endpoint to list overrides (protected) */
app.get('/api/lab-status', (req, res) => {
    const adminPwd = req.query.adminPwd;
    if (adminPwd !== ADMIN_PWD) return res.status(401).json({ ok: false, error: 'Senha administrativa inválida.' });
    res.json({ ok: true, overrides });
});

/* disable /api/labs management */
app.all('/api/labs', (_req, res) => {
    res.status(410).json({ ok: false, error: 'Gestão de labs desativada. Use .env LABS.' });
});

/* ===== START ===== */
app.listen(PORT, () => {
    console.log(`[HTTP] http://localhost:${PORT}`);
    console.log(`[INFO] Labs ativos: ${[...labs].join(', ')}`);
    console.log(`[INFO] ONLINE_THRESHOLD_MS = ${ONLINE_THRESHOLD_MS} ms`);
});
