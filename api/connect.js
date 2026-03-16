// api/connect.js
// Handles: POST /api/connect
// Actions:
//   save    — save a connected social account + contacts
//   list    — get all connected accounts for this user
//   remove  — disconnect a social account

const { handleOptions, getSupabase, success, error, getTokenFromRequest } = require('./_lib/helpers');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return error(res, 'Method not allowed', 405);

  const tokenData = getTokenFromRequest(req);
  if (!tokenData) return error(res, 'Authentication required', 401);

  const { action } = req.body || {};
  const supabase = getSupabase();

  // ════════════════════════════════════════
  // SAVE — Store connected social account
  // ════════════════════════════════════════
  if (action === 'save') {
    const { platform, handle, accessToken, contacts } = req.body;

    const validPlatforms = ['whatsapp', 'facebook', 'instagram'];
    if (!platform || !validPlatforms.includes(platform)) {
      return error(res, 'Invalid platform. Must be: whatsapp, facebook, or instagram');
    }
    if (!handle || handle.trim().length < 2) {
      return error(res, 'Account handle or phone number is required');
    }

    // Upsert the connection (update if exists, insert if new)
    const { data: connection, error: connErr } = await supabase
      .from('social_connections')
      .upsert({
        user_id: tokenData.userId,
        platform,
        handle: handle.trim(),
        access_token: accessToken || null,
        is_active: true,
        connected_at: new Date().toISOString(),
        contact_count: contacts?.length || 0,
      }, {
        onConflict: 'user_id,platform',
        ignoreDuplicates: false,
      })
      .select('id')
      .single();

    if (connErr) {
      console.error('Connection save error:', connErr);
      return error(res, 'Could not save connection. Please try again.', 500);
    }

    // If contacts array is provided, store them
    if (contacts && contacts.length > 0) {
      // Delete old contacts for this connection first
      await supabase
        .from('contacts')
        .delete()
        .eq('connection_id', connection.id);

      // Insert new contacts in batches of 100
      const contactRows = contacts.map(c => ({
        connection_id: connection.id,
        user_id: tokenData.userId,
        platform,
        phone_number: platform === 'whatsapp' ? (c.phone || c.phone_number || c) : null,
        platform_user_id: platform !== 'whatsapp' ? (c.id || c.platform_user_id || c) : null,
        display_name: c.name || c.display_name || null,
      }));

      // Batch insert
      const batchSize = 100;
      for (let i = 0; i < contactRows.length; i += batchSize) {
        const batch = contactRows.slice(i, i + batchSize);
        const { error: contactErr } = await supabase
          .from('contacts')
          .insert(batch);

        if (contactErr) {
          console.error('Contact batch insert error:', contactErr);
        }
      }
    }

    return success(res, {
      message: `${platform} connected successfully`,
      connectionId: connection.id,
      contactCount: contacts?.length || 0,
    });
  }

  // ════════════════════════════════════════
  // LIST — Get all connected accounts
  // ════════════════════════════════════════
  if (action === 'list') {
    const { data: connections, error: listErr } = await supabase
      .from('social_connections')
      .select('id, platform, handle, contact_count, connected_at, is_active')
      .eq('user_id', tokenData.userId)
      .eq('is_active', true)
      .order('connected_at', { ascending: false });

    if (listErr) return error(res, 'Could not fetch connections', 500);

    // Calculate total contacts
    const totalContacts = (connections || []).reduce((sum, c) => sum + (c.contact_count || 0), 0);

    return success(res, {
      connections: connections || [],
      totalContacts,
    });
  }

  // ════════════════════════════════════════
  // REMOVE — Disconnect a social account
  // ════════════════════════════════════════
  if (action === 'remove') {
    const { platform } = req.body;

    if (!platform) return error(res, 'Platform required');

    const { error: removeErr } = await supabase
      .from('social_connections')
      .update({ is_active: false, disconnected_at: new Date().toISOString() })
      .eq('user_id', tokenData.userId)
      .eq('platform', platform);

    if (removeErr) return error(res, 'Could not remove connection', 500);

    return success(res, { message: `${platform} disconnected successfully` });
  }

  // ════════════════════════════════════════
  // LISTCONTACTS — Get saved contacts for WhatsApp
  // ════════════════════════════════════════
  if (action === 'listcontacts') {
    const { data: conn } = await supabase
      .from('social_connections')
      .select('id')
      .eq('user_id', tokenData.userId)
      .eq('platform', 'whatsapp')
      .eq('is_active', true)
      .single();

    if (!conn) return success(res, { contacts: [] });

    const { data: contacts } = await supabase
      .from('contacts')
      .select('phone_number, display_name')
      .eq('connection_id', conn.id)
      .limit(500);

    return success(res, { contacts: contacts || [] });
  }

  return error(res, 'Invalid action. Use "save", "list", "listcontacts", or "remove"');
};
