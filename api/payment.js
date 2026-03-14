// api/payment.js
// Handles:
//   POST /api/payment/initiate  — create a $1 Flutterwave payment link
//   POST /api/payment/verify    — verify payment after redirect
//   POST /api/payment/webhook   — Flutterwave webhook (server-to-server)

const axios = require('axios');
const crypto = require('crypto');
const { handleOptions, getSupabase, success, error, getTokenFromRequest } = require('./_lib/helpers');

const FLW_BASE = 'https://api.flutterwave.com/v3';
const FLW_SECRET = process.env.FLW_SECRET_KEY;

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return error(res, 'Method not allowed', 405);

  const { action } = req.body || {};

  // ════════════════════════════════════════
  // INITIATE — Create $1 payment
  // ════════════════════════════════════════
  if (action === 'initiate') {
    const tokenData = getTokenFromRequest(req);
    if (!tokenData) return error(res, 'Authentication required', 401);

    const { contactCount, platforms, customerEmail, customerName, customerPhone } = req.body;

    if (!contactCount || contactCount < 1) {
      return error(res, 'No contacts connected. Please connect at least one social account.');
    }

    const supabase = getSupabase();

    // Create a pending alert record
    const txRef = `PG-ALERT-${tokenData.userId}-${Date.now()}`;

    const { data: alertRecord, error: dbErr } = await supabase
      .from('alerts')
      .insert({
        user_id: tokenData.userId,
        tx_ref: txRef,
        status: 'pending_payment',
        contact_count: contactCount,
        platforms: platforms || [],
        amount: 1.00,
        currency: 'USD',
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (dbErr) {
      console.error('Alert insert error:', dbErr);
      return error(res, 'Could not initiate alert. Please try again.', 500);
    }

    // Create Flutterwave payment link
    const payload = {
      tx_ref: txRef,
      amount: '1',
      currency: 'USD',
      redirect_url: `${process.env.APP_URL}/red-alert.html?payment=success&tx_ref=${txRef}`,
      meta: {
        alert_id: alertRecord.id,
        user_id: tokenData.userId,
        contact_count: contactCount,
      },
      customer: {
        email: customerEmail || 'user@phishguard.app',
        phonenumber: customerPhone || '',
        name: customerName || 'PhishGuard User',
      },
      customizations: {
        title: 'PhishGuard+ Red Alert',
        description: `Emergency broadcast to ${contactCount} contacts`,
        logo: `${process.env.APP_URL}/shield-icon.png`,
      },
      payment_options: 'card,ussd,mobilemoney,banktransfer,account',
    };

    try {
      const flwRes = await axios.post(`${FLW_BASE}/payments`, payload, {
        headers: {
          Authorization: `Bearer ${FLW_SECRET}`,
          'Content-Type': 'application/json',
        },
      });

      if (flwRes.data.status !== 'success') {
        return error(res, 'Payment gateway error. Please try again.', 502);
      }

      return success(res, {
        paymentLink: flwRes.data.data.link,
        txRef,
        alertId: alertRecord.id,
      });

    } catch (flwErr) {
      console.error('Flutterwave initiate error:', flwErr.response?.data || flwErr.message);
      return error(res, 'Payment service unavailable. Please try again.', 502);
    }
  }

  // ════════════════════════════════════════
  // VERIFY — Check payment status after redirect
  // ════════════════════════════════════════
  if (action === 'verify') {
    const { txRef, transactionId } = req.body;

    if (!txRef && !transactionId) {
      return error(res, 'Transaction reference or ID required');
    }

    try {
      let verifyRes;

      if (transactionId) {
        // Verify by transaction ID (more reliable)
        verifyRes = await axios.get(`${FLW_BASE}/transactions/${transactionId}/verify`, {
          headers: { Authorization: `Bearer ${FLW_SECRET}` }
        });
      } else {
        // Verify by tx_ref
        verifyRes = await axios.get(`${FLW_BASE}/transactions?tx_ref=${txRef}`, {
          headers: { Authorization: `Bearer ${FLW_SECRET}` }
        });
      }

      const txData = verifyRes.data.data;
      const tx = Array.isArray(txData) ? txData[0] : txData;

      if (!tx) return error(res, 'Transaction not found');

      const isSuccessful =
        tx.status === 'successful' &&
        parseFloat(tx.amount) >= 1.0 &&
        tx.currency === 'USD';

      if (!isSuccessful) {
        return error(res, `Payment not confirmed. Status: ${tx.status}`, 402);
      }

      // Update alert record to paid
      const supabase = getSupabase();
      const ref = txRef || tx.tx_ref;

      const { data: alert } = await supabase
        .from('alerts')
        .update({
          status: 'paid',
          flw_transaction_id: tx.id,
          paid_at: new Date().toISOString(),
        })
        .eq('tx_ref', ref)
        .select()
        .single();

      return success(res, {
        verified: true,
        alertId: alert?.id,
        txRef: ref,
        amount: tx.amount,
        currency: tx.currency,
      });

    } catch (verifyErr) {
      console.error('Verify error:', verifyErr.response?.data || verifyErr.message);
      return error(res, 'Could not verify payment. Please contact support.', 500);
    }
  }

  // ════════════════════════════════════════
  // WEBHOOK — Flutterwave server notification
  // ════════════════════════════════════════
  if (action === 'webhook') {
    // Verify webhook signature
    const signature = req.headers['verif-hash'];
    if (signature !== process.env.FLW_WEBHOOK_SECRET) {
      return error(res, 'Invalid webhook signature', 401);
    }

    const { event, data: tx } = req.body;

    if (event === 'charge.completed' && tx.status === 'successful') {
      const supabase = getSupabase();

      // Mark alert as paid
      await supabase
        .from('alerts')
        .update({
          status: 'paid',
          flw_transaction_id: tx.id,
          paid_at: new Date().toISOString(),
        })
        .eq('tx_ref', tx.tx_ref);

      console.log(`✅ Payment confirmed via webhook: ${tx.tx_ref}`);
    }

    return success(res, { received: true });
  }

  return error(res, 'Invalid action. Use "initiate", "verify", or "webhook"');
};
