// api/alert.js
// Handles: POST /api/alert
// Actions:
//   broadcast — send Red Alert via WhatsApp to all contacts
//   history   — get user's alert history
//   status    — get status of a specific alert
//
// Platform support: WhatsApp (Twilio) ✅
// Coming soon: Facebook Messenger, Instagram DM (Meta API — post-hackathon)

const twilio = require('twilio');
const { handleOptions, getSupabase, success, error, getTokenFromRequest } = require('./_lib/helpers');

// ── Twilio client (lazy init to avoid crash if env vars missing) ──
function getTwilio() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials not configured');
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return error(res, 'Method not allowed', 405);

  const tokenData = getTokenFromRequest(req);
  if (!tokenData) return error(res, 'Authentication required. Please log in again.', 401);

  const { action } = req.body || {};
  const supabase = getSupabase();

  // ════════════════════════════════════════
  // BROADCAST — Send Red Alert via WhatsApp
  // ════════════════════════════════════════
  if (action === 'broadcast') {
    const { alertId, customMessage } = req.body;

    if (!alertId) return error(res, 'Alert ID required');

    // ── Fetch & validate alert ────────────────────────────
    const { data: alert, error: alertErr } = await supabase
      .from('alerts')
      .select('*, users(name, email)')
      .eq('id', alertId)
      .eq('user_id', tokenData.userId)
      .single();

    if (alertErr || !alert) {
      return error(res, 'Alert not found or access denied', 404);
    }

    if (alert.status === 'sent') {
      return error(res, 'This alert has already been broadcast successfully');
    }

    if (alert.status !== 'paid') {
      return error(res, `Payment not confirmed yet. Status: ${alert.status}`, 402);
    }

    // ── Get WhatsApp connection ───────────────────────────
    const { data: connections } = await supabase
      .from('social_connections')
      .select('*')
      .eq('user_id', tokenData.userId)
      .eq('platform', 'whatsapp')
      .eq('is_active', true)
      .limit(1);

    const whatsappConnection = connections?.[0];

    if (!whatsappConnection) {
      return error(res, 'No WhatsApp account connected. Please connect WhatsApp first.');
    }

    // ── Build alert message ───────────────────────────────
    const userName = alert.users?.name || 'A PhishGuard+ user';
    const message = buildAlertMessage(userName, customMessage);

    // ── Mark as sending ───────────────────────────────────
    await supabase
      .from('alerts')
      .update({ status: 'sending', sent_at: new Date().toISOString() })
      .eq('id', alertId);

    // ── Fetch contacts ────────────────────────────────────
    const { data: contacts } = await supabase
      .from('contacts')
      .select('phone_number, display_name')
      .eq('connection_id', whatsappConnection.id)
      .not('phone_number', 'is', null)
      .limit(500);

    // ── If no contacts stored yet, send to registered number only ──
    const recipients = (contacts && contacts.length > 0)
      ? contacts
      : [{ phone_number: whatsappConnection.handle, display_name: userName }];

    // ── Send via Twilio WhatsApp ──────────────────────────
    const results = await sendWhatsAppBatch(recipients, message);

    // ── Save results to DB ────────────────────────────────
    const platformResults = [{
      platform: 'whatsapp',
      sent: results.sent,
      failed: results.failed,
      total: recipients.length,
    }];

    await supabase
      .from('alerts')
      .update({
        status: results.sent > 0 ? 'sent' : 'failed',
        delivered_count: results.sent,
        failed_count: results.failed,
        platform_results: platformResults,
        completed_at: new Date().toISOString(),
      })
      .eq('id', alertId);

    return success(res, {
      message: results.sent > 0
        ? `Red Alert sent to ${results.sent} contact${results.sent > 1 ? 's' : ''} via WhatsApp`
        : 'Broadcast attempted but no messages were delivered',
      delivered: results.sent,
      failed: results.failed,
      total: recipients.length,
      platforms: platformResults,
    });
  }

  // ════════════════════════════════════════
  // HISTORY
  // ════════════════════════════════════════
  if (action === 'history') {
    const { data: alerts, error: histErr } = await supabase
      .from('alerts')
      .select('id, status, contact_count, delivered_count, failed_count, platforms, platform_results, created_at, completed_at')
      .eq('user_id', tokenData.userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (histErr) return error(res, 'Could not fetch history', 500);
    return success(res, { alerts: alerts || [] });
  }

  // ════════════════════════════════════════
  // STATUS
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

// ── Build the Red Alert WhatsApp message ─────────────────────
function buildAlertMessage(userName, customNote) {
  const lines = [
    `*RED ALERT — ACCOUNT COMPROMISED*`,
    ``,
    `This is an automated security alert from PhishGuard+.`,
    ``,
    `${userName}'s account has been HACKED / COMPROMISED.`,
    ``,
    `If you receive any message from ${userName} asking for:`,
    `- Money or bank transfers`,
    `- OTP or verification codes`,
    `- Passwords or PINs`,
    `- Personal information`,
    ``,
    `DO NOT RESPOND — IT IS A SCAMMER.`,
    ``,
    `Please warn others who know ${userName}.`,
  ];

  if (customNote && customNote.trim()) {
    lines.push(``);
    lines.push(`Personal note from ${userName}:`);
    lines.push(`"${customNote.trim()}"`);
  }

  lines.push(``);
  lines.push(`Sent via PhishGuard+ Red Alert`);

  return lines.join('\n');
}

// ── Send WhatsApp messages in batches via Twilio ─────────────
async function sendWhatsAppBatch(recipients, message) {
  let sent = 0;
  let failed = 0;
  const twilioClient = getTwilio();
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

  const batchSize = 10;
  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);
    const promises = batch.map(async (contact) => {
      let phone = contact.phone_number || contact;
      if (!phone) return;
      phone = phone.toString().replace(/\s+/g, '');
      if (!phone.startsWith('+')) phone = '+' + phone;
      try {
        await twilioClient.messages.create({
          from: fromNumber,
          to: `whatsapp:${phone}`,
          body: message,
        });
        sent++;
      } catch (e) {
        console.error(`WhatsApp failed to ${phone}:`, e.message);
        failed++;
      }
    });
    await Promise.all(promises);
    if (i + batchSize < recipients.length) {
      await new Promise(r => setTimeout(r, 600));
    }
  }
  return { sent, failed };
}
