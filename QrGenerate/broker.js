// broker.js
import aedes from 'aedes';
import net from 'net';

const PORT = Number(process.env.MQTT_TCP_PORT || process.env.MQTT_PORT || 1883);
const a = aedes();

a.authenticate = (client, username, password, cb) => {
  const u = username ? username.toString() : '';
  const p = password ? password.toString() : '';
  const ok = (u === 'server'  && p === '12345678')
          || (u === 'sensor1' && p === '12345678'); // <-- ให้ ESP32 ใช้ user นี้ก็ได้
  if (ok) return cb(null, true);
  const err = new Error('Auth failed'); err.returnCode = 4; return cb(err, false);
};


a.on('client', (c) => console.log(new Date().toISOString(), '[broker] client connected:', c?.id));
a.on('clientDisconnect', (c) => console.log(new Date().toISOString(), '[broker] client disconnected:', c?.id));
a.on('publish', (packet, c) => {
  // แสดง log เฉพาะ message จาก client (ไม่ใช่ retained/internal)
  if (c) console.log(new Date().toISOString(), '[broker] publish', c?.id, packet.topic, packet.payload?.toString());
});
a.on('subscribe', (subs, c) => console.log(new Date().toISOString(), '[broker] subscribe', c?.id, subs.map(s=>s.topic).join(',')));

const server = net.createServer(a.handle);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[broker] listening on 0.0.0.0:${PORT}`);
});
