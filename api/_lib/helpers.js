// api/_lib/helpers.js
// Shared utilities for all API functions

const { createClient } = require('@supabase/supabase-js');

// ── CORS ────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.status(200).end();
    return true;
  }
  return false;
}

// ── SUPABASE CLIENT ─────────────────────────────────────────
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ── RESPONSE HELPERS ────────────────────────────────────────
function success(res, data, status = 200) {
  setCors(res);
  return res.status(status).json({ success: true, ...data });
}

function error(res, message, status = 400) {
  setCors(res);
  return res.status(status).json({ success: false, error: message });
}

// ── TOKEN HELPERS ───────────────────────────────────────────
function generateToken(userId) {
  // Simple signed token: base64(userId + timestamp) + signature
  const payload = Buffer.from(JSON.stringify({
    userId,
    iat: Date.now(),
    exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
  })).toString('base64');
  const sig = Buffer.from(`${payload}${process.env.JWT_SECRET}`).toString('base64').slice(0, 16);
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const [payload, sig] = token.split('.');
    const expectedSig = Buffer.from(`${payload}${process.env.JWT_SECRET}`).toString('base64').slice(0, 16);
    if (sig !== expectedSig) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function getTokenFromRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.replace('Bearer ', ''));
}

module.exports = { setCors, handleOptions, getSupabase, success, error, generateToken, verifyToken, getTokenFromRequest };
