// api/alert.js
// Handles: POST /api/alert
// Actions:
//   broadcast — send Red Alert to all connected contacts
//   history   — get user's alert history
//   status    — get status of a specific alert

const twilio = require('twilio');
const axios = require('axios');
const { handleOptions, getSupabase, success, error, getTokenFromRequest } = require('./_lib/helpers');

// ── Twilio (WhatsApp) ────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return error(res, 'Method not allowed', 405);

  const tokenData = getTokenFromRequest(req);
  if (!tokenData) return error(res, 'Authentication required. Please log in again.', 401);

  const { action } = req.body || {};
  const supabase = getSupabase();

  // ════════════════════════════════════════
  // BROADCAST — Send Red Alert to all contacts
  // ════════════════════════════════════════
  if (action === 'broadcast') {
    const { alertId, customMessage } = req.body;

    if (!alertId) return error(res, 'Alert ID required');

    // Verify the alert is paid and belongs to this user
    const { data: alert, error: alertErr } = await supabase
      .from('alerts')
      .select('*, users(name, email)')
      .eq('id', alertId)
      .eq('user_id', tokenData.userId)
      .single();

    if (alertErr || !alert) {
      return error(res, 'Alert not found or access denied', 404);
    }

    if (alert.status !== 'paid') {
      return error(res, `Payment required. Current status: ${alert.status}`, 402);
    }

    if (alert.status === 'sent') {
      return error(res, 'This alert has already been sent');
    }

    // Get user's connected social accounts & contacts
    const { data: connections } = await supabase
      .from('social_connections')
      .select('*')
      .eq('user_id', tokenData.userId)
      .eq('is_active', true);

    if (!connections || connections.length === 0) {
      return error(res, 'No social accounts connected. Please connect at least one platform.');
    }

    const userName = alert.users?.name || 'A PhishGuard+ user';
    const baseMessage = buildAlertMessage(userName, customMessage);

    // ── Update status to sending ──────────────────────────
    await supabase
      .from('alerts')
      .update({ status: 'sending', sent_at: new Date().toISOString() })
      .eq('id', alertId);

    const results = { sent: 0, failed: 0, platforms: [] };

    // ── Send to each connected platform ──────────────────
    for (const connection of connections) {
      try {
        let platformResult;

        switch (connection.platform) {
          case 'whatsapp':
            platformResult = await sendWhatsAppAlerts(connection, baseMessage, supabase);
            break;
          case 'facebook':
            platformResult = await sendFacebookAlerts(connection, baseMessage);
            break;
          case 'instagram':
            platformResult = await sendInstagramAlerts(connection, baseMessage);
            break;
          default:
            console.warn(`Unknown platform: ${connection.platform}`);
            continue;
        }

        results.sent += platformResult.sent;
        results.failed += platformResult.failed;
        results.platforms.push({
          platform: connection.platform,
          sent: platformResult.sent,
          failed: platformResult.failed,
        });

      } catch (platformErr) {
        console.error(`Error sending to ${connection.platform}:`, platformErr.message);
        results.failed++;
        results.platforms.push({
          platform: connection.platform,
          sent: 0,
          failed: 1,
          error: platformErr.message
        });
      }
    }

    // ── Mark alert as sent ────────────────────────────────
    await supabase
      .from('alerts')
      .update({
        status: 'sent',
        delivered_count: results.sent,
        failed_count: results.failed,
        completed_at: new Date().toISOString(),
        platform_results: results.platforms,
      })
      .eq('id', alertId);

    return success(res, {
      message: 'Red Alert broadcast complete',
      delivered: results.sent,
      failed: results.failed,
      platforms: results.platforms,
      totalContacts: results.sent + results.failed,
    });
  }

  // ════════════════════════════════════════
  // HISTORY — Get user's alert history
  // ════════════════════════════════════════
  if (action === 'history') {
    const { data: alerts, error: histErr } = await supabase
      .from('alerts')
      .select('id, status, contact_count, delivered_count, platforms, created_at, completed_at')
      .eq('user_id', tokenData.userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (histErr) return error(res, 'Could not fetch history', 500);

    return success(res, { alerts: alerts || [] });
  }

  // ════════════════════════════════════════
  // STATUS — Get status of a specific alert
  // ════════════════════════════════════════
  if (action === 'status') {
    const { alertId } = req.body;
    if (!alertId) return error(res, 'Alert ID required');

    const { data: alert, error: statusErr } = await supabase
      .from('alerts')
      .select('id, status, delivered_count, failed_count, platform_results, created_at, completed_at')
      .eq('id', alertId)
      .eq('user_id', tokenData.userId)
      .single();

    if (statusErr || !alert) return error(res, 'Alert not found', 404);

    return success(res, { alert });
  }

  return error(res, 'Invalid action. Use "broadcast", "history", or "status"');
};

// ── Alert message builder ────────────────────────────────────
function buildAlertMessage(userName, customNote) {
  const base = `🚨 URGENT SECURITY ALERT 🚨

This is an automated message from PhishGuard+.

⚠️ ${userName}'s account has been COMPROMISED / HACKED.

Any message you receive from ${userName} asking for:
• Money or bank transfers
• OTP or verification codes  
• Personal information
• Passwords or PINs

❌ IS NOT FROM THEM — IT IS A SCAMMER.

Please DO NOT respond to any such requests. Warn others who know ${userName}.`;

  if (customNote && customNote.trim()) {
    return `${base}\n\n📝 Personal note from ${userName}:\n"${customNote.trim()}"`;
  }

  return `${base}\n\n— Sent via PhishGuard+ Red Alert 🛡️\nphishguard.vercel.app`;
}

// ── WhatsApp via Twilio ──────────────────────────────────────
async function sendWhatsAppAlerts(connection, message, supabase) {
  const { data: contacts } = await supabase
    .from('contacts')
    .select('phone_number')
    .eq('connection_id', connection.id)
    .limit(500);

  if (!contacts || contacts.length === 0) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0, failed = 0;

  // Send in batches of 10 to avoid rate limiting
  const batches = chunk(contacts, 10);

  for (const batch of batches) {
    const promises = batch.map(async (contact) => {
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: `whatsapp:${contact.phone_number}`,
          body: message,
        });
        sent++;
      } catch (e) {
        console.error(`WhatsApp send failed to ${contact.phone_number}:`, e.message);
        failed++;
      }
    });
    await Promise.all(promises);
    // Small delay between batches
    await sleep(500);
  }

  return { sent, failed };
}

// ── Facebook Messenger via Meta Graph API ────────────────────
async function sendFacebookAlerts(connection, message) {
  const { data: contacts } = await require('./_lib/helpers').getSupabase()
    .from('contacts')
    .select('platform_user_id')
    .eq('connection_id', connection.id)
    .limit(500);

  if (!contacts || contacts.length === 0) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const token = connection.access_token || process.env.META_PAGE_ACCESS_TOKEN;

  for (const contact of contacts) {
    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/me/messages`,
        {
          recipient: { id: contact.platform_user_id },
          message: { text: message },
          messaging_type: 'MESSAGE_TAG',
          tag: 'ACCOUNT_UPDATE',
        },
        { params: { access_token: token } }
      );
      sent++;
    } catch (e) {
      console.error(`FB send failed to ${contact.platform_user_id}:`, e.response?.data || e.message);
      failed++;
    }
    await sleep(100); // Rate limiting
  }

  return { sent, failed };
}

// ── Instagram DM via Meta Graph API ─────────────────────────
async function sendInstagramAlerts(connection, message) {
  const { data: contacts } = await require('./_lib/helpers').getSupabase()
    .from('contacts')
    .select('platform_user_id')
    .eq('connection_id', connection.id)
    .limit(500);

  if (!contacts || contacts.length === 0) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const token = connection.access_token || process.env.META_PAGE_ACCESS_TOKEN;

  for (const contact of contacts) {
    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/me/messages`,
        {
          recipient: { id: contact.platform_user_id },
          message: { text: message },
        },
        { params: { access_token: token } }
      );
      sent++;
    } catch (e) {
      console.error(`IG send failed to ${contact.platform_user_id}:`, e.response?.data || e.message);
      failed++;
    }
    await sleep(100);
  }

  return { sent, failed };
}

// ── Utilities ────────────────────────────────────────────────
function chunk(arr, size) {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
