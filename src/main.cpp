/******************************************************
 * Campainha do Laboratório via MQTT
 ******************************************************/

#include <WiFi.h>
#include <PubSubClient.h>

// --------- CONFIG WIFI (Wokwi) ---------
const char *WIFI_SSID = "LAR-IFCE";
const char *WIFI_PASS = "if.LAR@2024";

// --------- CONFIG MQTT (TESTE) ---------
const char *MQTT_HOST = "broker.emqx.io";
const uint16_t MQTT_PORT = 1883;

// --------- IDENTIDADE / TÓPICO ---------
const char *LAB_ID = "LAPADA";
String TOPIC_RING = String("lab/") + LAB_ID + "/ring";
String TOPIC_STATUS = String("lab/") + LAB_ID + "/status"; // <- status heartbeat

// --------- HARDWARE ---------
const int BUZZER_PIN = 27;
const int BUZZER_CH = 0;
const unsigned long DEFAULT_RING_MS = 3000;
const unsigned long DEVICE_COOLDOWN_MS = 800;

// --------- HEARTBEAT ---------
const unsigned long HB_INTERVAL = 10000UL; // 10s
unsigned long lastHb = 0UL;

// --------- OBJETOS DE REDE ---------
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

// Guarda o instante do último toque (millis desde o boot)
unsigned long lastRingAt = 0;

/* ---------- funcoes auxiliares (mantenha suas implementações) ---------- */

unsigned long parseDurationMs(const char *payload, unsigned int length)
{
  String s;
  s.reserve(length + 1);
  for (unsigned i = 0; i < length; i++)
    s += (char)payload[i];
  s.trim();

  if (s.startsWith("ms="))
  {
    long v = s.substring(3).toInt();
    if (v > 0 && v <= 10000)
      return (unsigned long)v;
  }

  bool allDigits = s.length() > 0;
  for (size_t i = 0; i < s.length(); i++)
  {
    if (!isDigit(s[i]))
    {
      allDigits = false;
      break;
    }
  }
  if (allDigits)
  {
    long v = s.toInt();
    if (v > 0 && v <= 10000)
      return (unsigned long)v;
  }

  return DEFAULT_RING_MS;
}

void playDingDong()
{
  const int notes[] = {1319, 1568, 1760, 2093};
  const int noteDurations[] = {100, 120, 140, 300};

  for (int i = 0; i < 4; i++)
  {
    tone(BUZZER_PIN, notes[i]);
    int mainDuration = noteDurations[i] - 30;
    delay(mainDuration);
    noTone(BUZZER_PIN);
    if (i < 3)
      delay(30);
  }
}

/* ---------- callback MQTT (quando chega ring) ---------- */

void onMqttMessage(char *topic, byte *payload, unsigned int length)
{
  Serial.print("[MQTT] msg em ");
  Serial.print(topic);
  Serial.print(": ");
  for (unsigned i = 0; i < length; i++)
    Serial.print((char)payload[i]);
  Serial.println();

  unsigned long ms = parseDurationMs((const char *)payload, length);
  playDingDong(); // toca
}

/* ---------- Função de heartbeat (publica status online) ---------- */

void publishHeartbeat()
{
  const char *payload = "online";
  const bool retained = true; // opcional

  if (!mqtt.connected())
  {
    Serial.println("[HB] MQTT desconectado. Tentando reconectar...");
    // tente reconectar (ensureMqtt fará tentativas)
    // chame ensureMqtt() aqui — se preferir, remova a chamada e deixe ensureMqtt no loop
    // ensureMqtt();
    if (!mqtt.connected())
    {
      Serial.println("[HB] Ainda não conectado. Abortando heartbeat.");
      return;
    }
  }

  bool ok = mqtt.publish(TOPIC_STATUS.c_str(), payload, retained);
  if (ok)
  {
    Serial.printf("[HB] publicado em %s\n", TOPIC_STATUS.c_str());
  }
  else
  {
    Serial.printf("[HB] falha publicar em %s\n", TOPIC_STATUS.c_str());
  }
}

/* ---------- WiFi / MQTT helpers ---------- */

void ensureWifi()
{
  if (WiFi.status() == WL_CONNECTED)
    return;

  Serial.print("[WiFi] conectando a ");
  Serial.println(WIFI_SSID);

  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000)
  {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.print("[WiFi] ok, IP: ");
    Serial.println(WiFi.localIP());
  }
  else
  {
    Serial.println("[WiFi] falha");
  }
}

void ensureMqtt()
{
  while (!mqtt.connected())
  {
    String cid = String("campainha-") + LAB_ID + "-" + String((uint32_t)esp_random(), HEX);
    Serial.print("[MQTT] conectando como ");
    Serial.println(cid);

    if (mqtt.connect(cid.c_str()))
    {
      Serial.println("[MQTT] conectado!");
      mqtt.subscribe(TOPIC_RING.c_str(), 1);
      Serial.print("[MQTT] inscrito em: ");
      Serial.println(TOPIC_RING);

      // publica heartbeat imediato
      publishHeartbeat();
      lastHb = millis();
    }
    else
    {
      Serial.print("[MQTT] erro, rc=");
      Serial.println(mqtt.state());
      delay(1200);
    }
  }
}

/* ---------- setup / loop ---------- */

void setup()
{
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  ledcSetup(BUZZER_CH, 2000, 10);
  ledcAttachPin(BUZZER_PIN, BUZZER_CH);
  digitalWrite(BUZZER_PIN, LOW);

  ensureWifi();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
}

void loop()
{
  ensureWifi();
  if (!mqtt.connected())
    ensureMqtt();
  mqtt.loop();

  // heartbeat periódica
  if (millis() - lastHb >= HB_INTERVAL)
  {
    publishHeartbeat();
    lastHb = millis();
  }

  delay(5);
}
