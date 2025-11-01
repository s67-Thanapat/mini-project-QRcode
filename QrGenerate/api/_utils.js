// api/_utils.js
import fetch from 'node-fetch';
import https from 'https';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY
} = process.env;

// Optional insecure TLS support for dev environments behind intercepting proxies
const INSECURE_TLS = (process.env.INSECURE_TLS === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0');
const insecureAgent = INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

export function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
}

export async function supaInsert(table, rows) {
  assertSupabaseConfig();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(rows),
    // Allow bypassing TLS verification only when explicitly requested
    agent: insecureAgent
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data;
}

export async function supaSelect(urlPath, useService = true) {
  assertSupabaseConfig();
  const headers = {
    apikey: useService ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY,
    Authorization: `Bearer ${useService ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY}`
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { headers, agent: insecureAgent });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getUserFromToken(token) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Missing SUPABASE_URL/ANON_KEY');
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
  });
  if (!res.ok) throw new Error('token invalid');
  return res.json();
}

export async function isAdmin(user_id) {
  const rows = await supaSelect(`/rest/v1/admins?user_id=eq.${user_id}&select=user_id`, true);
  return rows.length > 0;
}
