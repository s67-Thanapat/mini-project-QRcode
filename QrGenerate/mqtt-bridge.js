// mqtt-bridge.js - เวอร์ชันแก้ไขแล้ว
// Handle presence/thumb via MQTT and call local API accordingly

import mqtt from 'mqtt';
import fetch from 'node-fetch';

const {
  SITE = 'gateA',
  DEVICE_ID = 'esp32-01',
  MQTT_URL = 'mqtt://127.0.0.1:1883',
  MQTT_USER_SERVER = 'server',
  MQTT_PASS_SERVER = '12345678',
  PORT = 9000,
  SESSION_TTL_MS = '6000'
} = process.env;

const SESSION_TTL = Number(SESSION_TTL_MS) || 6000;

const topic = {
  presence: `${SITE}/${DEVICE_ID}/event/presence`,
  thumb: `${SITE}/${DEVICE_ID}/ui/thumb`,
  armed: `${SITE}/${DEVICE_ID}/ui/armed`,
  cancel: `${SITE}/${DEVICE_ID}/ui/cancel`,
  session: `${SITE}/${DEVICE_ID}/ui/session_status`
};

const initialSession = () => ({
  armed: false,
  presence: false,
  thumb: false,
  timer: null,
  startedAt: 0,
  qrGenerated: false
});

let session = initialSession();

const log = (...a) => console.log(new Date().toISOString(), ...a);

export function attachMqttBridge({ onToggleSensor, onEvent } = {}) {
  const client = mqtt.connect(MQTT_URL, {
    username: MQTT_USER_SERVER,
    password: MQTT_PASS_SERVER,
    keepalive: 60,
    reconnectPeriod: 1000
  });

  const emit = (topicName, payload, meta = {}) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ topic: topicName, payload, ...meta });
    } catch (err) {
      log('[sse] emit error:', err?.message || err);
    }
  };

  const publish = (key, payload, options = {}) => {
    const topicName = topic[key];
    if (!topicName) return;
    client.publish(topicName, JSON.stringify(payload), { qos: 1, ...options });
    emit(topicName, payload, { direction: 'outbound' });
  };

  const resetSession = () => {
    if (session.timer) clearTimeout(session.timer);
    session = initialSession();
  };

  const clearSession = (silent = false, payload = { reason: 'timeout_or_done' }) => {
    resetSession();
    if (!silent) {
      publish('cancel', payload);
      const reason = payload && typeof payload === 'object' ? payload.reason : undefined;
      const extra = payload && typeof payload === 'object' ? { ...payload } : {};
      // Include reason (and any extra info) in session idle so UI can display it
      publish('session', { status: 'idle', reason, ...extra, timestamp: Date.now() });
    }
    log('[session] cleared');
  };

  const armSession = () => {
    if (session.timer) clearTimeout(session.timer);
    session.armed = true;
    session.presence = true;
    session.startedAt = Date.now();
    session.timer = setTimeout(() => {
      log('[session] TTL expired');
      clearSession(false, { reason: 'ttl_expired' });
    }, SESSION_TTL);

    publish('armed', { ttl: SESSION_TTL });
    publish('session', { status: 'armed', ttl: SESSION_TTL, timestamp: Date.now() });
    log('[session] armed -> publish armed');
  };

  client.on('connect', () => {
    log('[mqtt] connected');
    const subscriptions = [topic.presence, topic.thumb, topic.session, topic.armed, topic.cancel];
    client.subscribe(subscriptions, { qos: 1 }, (err) => {
      if (err) log('[mqtt] subscribe error:', err.message);
      else log('[mqtt] subscribed:', subscriptions.join(', '));
    });
  });

  client.on('reconnect', () => log('[mqtt] reconnect...'));
  client.on('error', (e) => log('[mqtt] error:', e?.message || e));

  client.on('message', async (t, message) => {
    let data = {};
    try {
      data = JSON.parse(message.toString() || '{}');
    } catch {
      data = {};
    }

    if (t === topic.presence) {
      const present = Boolean(data.present ?? true);
      emit(topic.presence, { ...data, present }, { direction: 'inbound' });
      log('[mqtt] presence:', present, data);
      if (present) {
        armSession();
        publish('session', {
          status: 'sensor_detected',
          timestamp: Date.now()
        });
      } else {
        clearSession(false, { reason: 'no_presence' });
      }
      return;
    }

    if (t === topic.thumb) {
      emit(topic.thumb, data, { direction: 'inbound' });
      const holdComplete = data?.hold_complete === true;
      const thumbFlag = Boolean(data?.thumb);
      const progress = typeof data?.progress === 'number' ? data.progress : null;

      if (!holdComplete) {
        if (!thumbFlag) {
          session.thumb = false;
          log('[mqtt] thumb-reset:', data);
        } else {
          const displayProgress = progress !== null ? Number(progress).toFixed(2) : null;
          log('[mqtt] thumb-progress:', displayProgress, data);
        }
        return;
      }

      log('[mqtt] thumb-complete:', data);

      if (session.armed && session.presence && !session.thumb) {
        session.thumb = true;

        publish('session', {
          status: 'thumb_detected',
          timestamp: Date.now()
        });

        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/api/qr-create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              via: 'mqtt-bridge',
              site: SITE,
              device_id: DEVICE_ID,
              trigger: 'sensor_and_thumb'
            })
          });
          const body = await res.json();
          if (res.ok && body?.ok) {
            session.qrGenerated = true;
            publish('cancel', {
              success: true,
              qr_id: body.qr?.id
            });
            publish('session', {
              status: 'qr_generated',
              qr_data: body.qr,
              timestamp: Date.now()
            });
          } else {
            publish('cancel', {
              success: false,
              error: body?.error || 'create failed'
            });
          }
        } catch (e) {
          publish('cancel', {
            success: false,
            error: e.message
          });
        } finally {
          clearSession(true);
        }
      } else {
        log('[mqtt] thumb ignored (not armed or already processed)');
      }
      return;
    }

    if (t === topic.session) {
      emit(topic.session, data, { direction: 'inbound' });
      log('[mqtt] session_status:', data);
      return;
    }

    if (t === topic.armed) {
      emit(topic.armed, data, { direction: 'inbound' });
      log('[mqtt] armed status:', data);
      return;
    }

    if (t === topic.cancel) {
      emit(topic.cancel, data, { direction: 'inbound' });
      log('[mqtt] cancel status:', data);
      return;
    }
  });

  if (typeof onToggleSensor === 'function') {
    onToggleSensor(true);
  }

  return client;
}

// Export default สำหรับ backward compatibility
export default { attachMqttBridge };
