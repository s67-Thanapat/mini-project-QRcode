// api/health.js
export default (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    ua: req.headers['user-agent'] || null
  });
};
