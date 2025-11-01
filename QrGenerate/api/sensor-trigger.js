// api/sensor-trigger.js
// ใช้ทดสอบแทน MQTT: present=true -> arm session ผ่าน MQTT bridge โดยตรงไม่ได้
// ที่นี่แค่ตอบรับไว้ให้ manual test (เชิง stateless)

export default (req, res) => {
  const present = Boolean(req.body?.present ?? true);
  res.json({ ok: true, note: 'HTTP trigger accepted (demo stub)', present });
};
