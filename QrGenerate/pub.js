// pub.js
import mqtt from 'mqtt';

const [, , topic, payload = '{}'] = process.argv;
if (!topic) {
  console.error('Usage: node pub.js <topic> [payloadJSON]');
  process.exit(1);
}

const client = mqtt.connect('mqtt://127.0.0.1:1883', {
  username: 'server',
  password: '12345678',
  reconnectPeriod: 1000,
});

client.on('connect', () => {
  client.publish(topic, payload, { qos: 1 }, () => {
    console.log('[pub] published:', topic, payload);
    client.end();
  });
});
client.on('error', (e) => console.log('[pub] error:', e?.message || e));
