// api/auth.js
// Handles: POST /api/auth
// Actions: register (new user), login (returning user)

const bcrypt = require('bcryptjs');
const { handleOptions, getSupabase, success, error, generateToken } = require('./_lib/helpers');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return error(res, 'Method not allowed', 405);

  const { action, pin, name, email } = req.body || {};

  // ── Validate PIN ─────────────────────────────────────────
  if (!pin || !/^\d{4}$/.test(pin)) {
    return error(res, 'PIN must be exactly 4 digits');
  }

  const supabase = getSupabase();

  // ════════════════════════════════════════
  // REGISTER — new user sets their 4-digit PIN
  // ════════════════════════════════════════
  if (action === 'register') {
    if (!name || name.trim().length < 2) {
      return error(res, 'Please provide your name (minimum 2 characters)');
    }

    // Hash the PIN with bcrypt (salt rounds = 10)
    const pinHash = await bcrypt.hash(pin, 10);

    const { data: user, error: dbError } = await supabase
      .from('users')
      .insert({
        name: name.trim(),
        email: email?.trim() || null,
        pin_hash: pinHash,
        created_at: new Date().toISOString(),
      })
      .select('id, name, email, created_at')
      .single();

    if (dbError) {
      console.error('Register error:', dbError);
      // Handle duplicate email
      if (dbError.code === '23505') {
        return error(res, 'An account with this email already exists. Please login instead.');
      }
      return error(res, 'Could not create account. Please try again.', 500);
    }

    const token = generateToken(user.id);

    return success(res, {
      message: 'Account created successfully',
      token,
      user: { id: user.id, name: user.name, email: user.email }
    }, 201);
  }

  // ════════════════════════════════════════
  // LOGIN — returning user verifies PIN
  // Body must include: pin + either email or userId
  // ════════════════════════════════════════
  if (action === 'login') {
    const { userId, email: loginEmail } = req.body;

    let query = supabase.from('users').select('id, name, email, pin_hash');

    if (userId) {
      query = query.eq('id', userId);
    } else if (loginEmail) {
      query = query.eq('email', loginEmail.trim());
    } else {
      return error(res, 'Please provide your user ID or email to login');
    }

    const { data: user, error: fetchError } = await query.single();

    if (fetchError || !user) {
      return error(res, 'Account not found. Please register first.');
    }

    const pinMatch = await bcrypt.compare(pin, user.pin_hash);

    if (!pinMatch) {
      // Log failed attempt (optional: add rate limiting here)
      return error(res, 'Incorrect PIN. Please try again.', 401);
    }

    const token = generateToken(user.id);

    return success(res, {
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  }

  return error(res, 'Invalid action. Use "register" or "login"');
};
