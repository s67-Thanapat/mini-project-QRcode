// api/sensor-enabled.js
let SENSOR_ENABLED = true;

export function setSensorEnabled(val) {
  SENSOR_ENABLED = !!val;
}

export default (req, res) => {
  if (typeof req.body?.enabled === 'boolean') {
    SENSOR_ENABLED = req.body.enabled;
  }
  res.json({ ok: true, enabled: SENSOR_ENABLED });
};
