// sub.js
import mqtt from 'mqtt';

const TOPIC = process.argv[2] || '#';
const client = mqtt.connect('mqtt://127.0.0.1:1883', {
  username: 'server',
  password: '12345678',
  reconnectPeriod: 1000,
});

client.on('connect', () => {
  console.log('[sub] connected, subscribing:', TOPIC);
  client.subscribe(TOPIC, { qos: 1 });
});
client.on('message', (topic, msg) => {
  console.log('[sub]', topic, msg.toString());
});
client.on('error', (e) => console.log('[sub] error:', e?.message || e));
