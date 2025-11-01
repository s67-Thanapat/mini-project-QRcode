// server.js
// Boot REST API + attach MQTT bridge

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

import health from './api/health.js';
import qrCreate from './api/qr-create.js';
import sensorTrigger from './api/sensor-trigger.js';
import sensorEnabledRoute, { setSensorEnabled } from './api/sensor-enabled.js';
import adminMe from './api/admin-me.js';
import adminResetPassword from './api/admin-reset-password.js';

import { attachMqttBridge } from './mqtt-bridge.js';

const {
  PORT = 9000,
  ALLOWED_ORIGINS = '',
  CAMERA_STREAM_URL = 'http://127.0.0.1:9101/stream'
} = process.env;

const app = express();
app.use(express.json());

// CORS
const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error('CORS blocked: ' + origin));
    },
    credentials: true,
    methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization']
  })
);
app.options('*', cors());

// API routes
app.get('/api/health', health);
app.post('/api/qr-create', qrCreate);
app.post('/api/sensor-trigger', sensorTrigger);
app.post('/api/sensor-enabled', sensorEnabledRoute);
app.get('/admin/me', adminMe);
app.post('/admin/reset-password', adminResetPassword);

// static front-end
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// proxy camera stream so UI can stay on same origin/port
app.get('/camera/stream', async (req, res) => {
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    if (req.socket) {
      req.socket.setKeepAlive(true, 15000);
      req.socket.setNoDelay(true);
    }
    if (res.socket) {
      res.socket.setNoDelay(true);
    }

    const upstream = await fetch(CAMERA_STREAM_URL, {
      signal: controller.signal,
      headers: { Accept: 'multipart/x-mixed-replace' }
    });

    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status || 502).send('Camera stream unavailable');
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=frame';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      const status = err.name === 'AbortError' ? 499 : 503;
      res.status(status).send('Camera stream error');
    }
  }
});

// เพิ่มใน server.js ก่อนส่วน app.listen()

// simple in-memory SSE registry; replace with shared store if scaling out
const sseClients = new Map();

function broadcastSSE(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const { res } of sseClients.values()) {
    res.write(payload);
  }
}

// Server-Sent Events for real-time updates
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(': connected\n\n'); // initial comment to keep connection alive

  const clientId = Date.now();
  sseClients.set(clientId, { id: clientId, res });
  console.log(`[SSE] Client connected: ${clientId}`);

  const heartbeat = setInterval(() => {
    broadcastSSE({ type: 'heartbeat', time: new Date().toISOString() });
  }, 30000);

  req.on('close', () => {
    console.log(`[SSE] Client disconnected: ${clientId}`);
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  });
});

// start http
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 server listening on http://0.0.0.0:${PORT}`);
});

// attach mqtt bridge AFTER server up
attachMqttBridge({
  onToggleSensor: (enabled) => setSensorEnabled(enabled),
  onEvent: (event) => {
    if (!event || typeof event !== 'object') return;
    broadcastSSE({ type: 'mqtt', ...event });
  }
});
