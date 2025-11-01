// api/qr-create.js
// Create short UUID and persist to table public.genqrcode (uuid, user_agent)

import { supaInsert } from './_utils.js';

function genCode(len = 12) {
  let out = '';
  while (out.length < len) {
    const chunk = Math.random().toString(36).slice(2).toUpperCase();
    out += chunk.replace(/[^A-Z0-9]/g, '');
  }
  return out.slice(0, len);
}

export default async (req, res) => {
  try {
    const ua = req.headers['user-agent'] || null;
    const uuid = genCode(12);

    // Try Supabase insert first
    try {
      const rows = await supaInsert('genqrcode', [{ uuid, user_agent: ua }]);
      const row = rows[0]; // { id, uuid, user_agent, created_at }
      res.json({
        ok: true,
        qr: {
          id: row.id,
          uuid: row.uuid,
          user_agent: row.user_agent,
          created_at: row.created_at,
          payload: row.uuid
        }
      });
      return;
    } catch (dbErr) {
      // Optional offline mode for environments with TLS/proxy issues
      if (process.env.QR_OFFLINE_MODE === '1') {
        res.json({
          ok: true,
          qr: {
            id: null,
            uuid,
            user_agent: ua,
            created_at: new Date().toISOString(),
            payload: uuid,
            offline: true,
            reason: 'offline_mode'
          }
        });
        return;
      }
      throw dbErr;
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

