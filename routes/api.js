import express from 'express';
import { query } from '../services/db.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Generic CRUD relay — replaces the old Vercel serverless /api/db endpoint.
 * The frontend sends { action, collection, filter?, update? }.
 */
router.post('/db', async (req, res) => {
  const { action, collection, filter, update } = req.body;
  const table = collection || 'provisioning_logs';

  try {
    switch (action) {
      case 'ping': {
        const probe = await query('SELECT 1');
        return res.json({ ok: true, status: 200, schemaReady: true, details: 'Handshake successful' });
      }

      case 'find': {
        let sql, params;
        if (filter?.id) {
          sql = `SELECT * FROM "${table}" WHERE id = $1`;
          params = [filter.id];
        } else {
          sql = `SELECT * FROM "${table}"`;
          params = [];
        }
        const result = await query(sql, params);
        return res.json({ documents: result.rows });
      }

      case 'updateOne': {
        const payload = update?.$set || {};
        if (!payload.id) {
          return res.status(400).json({ error: 'Missing id in payload' });
        }

        // JSONB columns that need explicit JSON.stringify + cast
        const jsonbColumns = new Set(['assignedPageIds', 'assignedAgentIds']);

        const columns = Object.keys(payload);
        // Serialize arrays/objects for JSONB columns so node-pg doesn't
        // convert them to PostgreSQL array literals
        const values = columns.map((col) => {
          const val = payload[col];
          if (jsonbColumns.has(col)) {
            // Always store as JSON string for JSONB columns
            if (val === null || val === undefined) return '[]';
            return JSON.stringify(val);
          }
          return val;
        });

        const placeholders = columns.map((col, i) => {
          if (jsonbColumns.has(col)) return `$${i + 1}::jsonb`;
          return `$${i + 1}`;
        });
        const updateSet = columns.map((col, i) => {
          if (jsonbColumns.has(col)) return `"${col}" = $${i + 1}::jsonb`;
          return `"${col}" = $${i + 1}`;
        }).join(', ');

        const sql = `
          INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
          VALUES (${placeholders.join(', ')})
          ON CONFLICT (id) DO UPDATE SET ${updateSet}
          RETURNING id
        `;

        const result = await query(sql, values);
        return res.json({ ok: true, upsertedId: result.rows[0]?.id });
      }

      case 'deleteOne': {
        if (!filter?.id) {
          return res.status(400).json({ error: 'Missing filter.id' });
        }
        await query(`DELETE FROM "${table}" WHERE id = $1`, [filter.id]);
        return res.json({ ok: true });
      }

      case 'deleteMany': {
        await query(`DELETE FROM "${table}"`);
        return res.json({ ok: true });
      }

      case 'listCollections': {
        const tables = ['agents', 'pages', 'conversations', 'messages', 'links', 'media', 'provisioning_logs'];
        const stats = await Promise.all(
          tables.map(async (t) => {
            try {
              const result = await query(`SELECT COUNT(*) as count FROM "${t}"`);
              return { name: t, exists: true, count: parseInt(result.rows[0].count) };
            } catch {
              return { name: t, exists: false, count: 0 };
            }
          })
        );
        return res.json({ ok: true, collections: stats });
      }

      default:
        return res.status(400).json({ error: 'Invalid operation' });
    }
  } catch (error) {
    logger.error(`DB operation [${action}] on [${table}] failed:`, error.message);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Sync recent conversations from FB
 */
router.post('/sync-conversations', async (req, res) => {
  try {
    const { pageId, limit = 5 } = req.body;
    if (!pageId) return res.status(400).json({ error: 'pageId is required' });

    const result = await query(
      `SELECT * FROM conversations WHERE "pageId" = $1 ORDER BY "lastTimestamp" DESC LIMIT $2`,
      [pageId, limit]
    );
    res.json({ conversations: result.rows });
  } catch (error) {
    logger.error('Error syncing conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get messages for a conversation
 */
router.get('/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const result = await query(
      `SELECT * FROM messages WHERE "conversationId" = $1 ORDER BY timestamp ASC`,
      [conversationId]
    );
    res.json({ messages: result.rows });
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send message — stores in DB + emits via Socket.IO + calls Facebook API
 */
router.post('/send-message', async (req, res) => {
  try {
    const { conversationId, text, senderId, senderName, customerId, pageAccessToken, isWindowExpired } = req.body;

    if (!conversationId || !text) {
      return res.status(400).json({ error: 'conversationId and text are required' });
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();

    // Store message in DB
    await query(
      `INSERT INTO messages (id, "conversationId", "senderId", "senderName", text, timestamp, "isIncoming", "isRead")
       VALUES ($1, $2, $3, $4, $5, $6, false, true)`,
      [messageId, conversationId, senderId || 'agent', senderName || 'Agent', text, timestamp]
    );

    // Update conversation's last message
    await query(
      `UPDATE conversations SET "lastMessage" = $1, "lastTimestamp" = $2 WHERE id = $3`,
      [text, timestamp, conversationId]
    );

    const message = {
      id: messageId,
      conversationId,
      senderId: senderId || 'agent',
      senderName: senderName || 'Agent',
      text,
      timestamp,
      isIncoming: false,
      isRead: true,
    };

    // Call Facebook Send API if we have the token
    let fbResponse = null;
    if (customerId && pageAccessToken) {
      try {
        const fbUrl = `https://graph.facebook.com/v22.0/me/messages?access_token=${pageAccessToken}`;
        const payload = {
          recipient: { id: customerId },
          message: { text },
          messaging_type: isWindowExpired ? 'MESSAGE_TAG' : 'RESPONSE',
        };
        if (isWindowExpired) payload.tag = 'HUMAN_AGENT';

        const fbRes = await fetch(fbUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        fbResponse = await fbRes.json();

        if (fbResponse.error) {
          logger.error('Facebook send error:', fbResponse.error);
          return res.status(400).json({ error: fbResponse.error.message, fbError: fbResponse.error });
        }
      } catch (fbErr) {
        logger.error('Facebook API call failed:', fbErr.message);
        return res.status(500).json({ error: 'Facebook API call failed: ' + fbErr.message });
      }
    }

    // Emit via Socket.IO (attached to req by middleware)
    if (req.io) {
      req.io.emit('new_message', message);
      req.io.emit('conversation_updated', {
        id: conversationId,
        lastMessage: text,
        lastTimestamp: timestamp,
      });
    }

    logger.info('Message sent:', messageId);
    res.json({ message, fbResponse });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update conversation status
 */
router.patch('/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const keys = Object.keys(updates);
    const values = Object.values(updates);

    const setClause = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
    const result = await query(
      `UPDATE conversations SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (req.io) {
      req.io.emit('conversation_updated', result.rows[0]);
    }

    res.json({ conversation: result.rows[0] });
  } catch (error) {
    logger.error('Error updating conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Subscribe a page to app webhooks (called when page is connected)
 */
router.post('/subscribe-page', async (req, res) => {
  try {
    const { pageId, accessToken } = req.body;
    if (!pageId || !accessToken) {
      return res.status(400).json({ error: 'pageId and accessToken are required' });
    }

    const fbRes = await fetch(
      `https://graph.facebook.com/v22.0/${pageId}/subscribed_apps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscribed_fields: 'messages,messaging_postbacks,message_deliveries,message_reads',
          access_token: accessToken,
        }),
      }
    );
    const data = await fbRes.json();

    if (data.success) {
      logger.info(`Page ${pageId} subscribed to app webhooks`);
      res.json({ ok: true });
    } else {
      logger.error(`Failed to subscribe page ${pageId}:`, data);
      res.status(400).json({ error: data.error?.message || 'Subscription failed', details: data });
    }
  } catch (error) {
    logger.error('Error subscribing page:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Exchange a short-lived Facebook user token for a long-lived one,
 * then retrieve page tokens (which never expire).
 */
router.post('/fb/exchange-token', async (req, res) => {
  const { shortLivedToken } = req.body;
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;

  if (!appId || !appSecret) {
    return res.status(500).json({ error: 'FB_APP_ID or FB_APP_SECRET not configured on server' });
  }
  if (!shortLivedToken) {
    return res.status(400).json({ error: 'shortLivedToken is required' });
  }

  try {
    // Step 1: Exchange short-lived user token for long-lived user token (~60 days)
    const exchangeUrl = `https://graph.facebook.com/v22.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
    const exchangeRes = await fetch(exchangeUrl);
    const exchangeData = await exchangeRes.json();

    if (exchangeData.error) {
      logger.error('Token exchange failed:', exchangeData.error);
      return res.status(400).json({ error: exchangeData.error.message });
    }

    const longLivedUserToken = exchangeData.access_token;

    // Step 2: Fetch page tokens using the long-lived user token.
    // Page tokens obtained this way NEVER expire.
    const pagesUrl = `https://graph.facebook.com/v22.0/me/accounts?access_token=${longLivedUserToken}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();

    if (pagesData.error) {
      logger.error('Failed to fetch pages with long-lived token:', pagesData.error);
      return res.status(400).json({ error: pagesData.error.message });
    }

    logger.info(`Token exchange successful. Retrieved ${pagesData.data?.length || 0} pages with permanent tokens.`);
    res.json({
      pages: pagesData.data || [],
      longLivedUserToken,
      expiresIn: exchangeData.expires_in || null,
    });
  } catch (error) {
    logger.error('Token exchange error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Public config — returns non-secret values the frontend may need
 */
router.get('/config', (_req, res) => {
  res.json({
    fbAppId: process.env.FB_APP_ID || '',
  });
});

/**
 * Mark conversation as read (when user opens the chat)
 */
router.post('/conversations/:id/mark-read', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Mark all unread incoming messages in this conversation as read
    await query(
      `UPDATE messages SET "isRead" = true 
       WHERE "conversationId" = $1 AND "isIncoming" = true AND "isRead" = false`,
      [id]
    );
    
    // Reset conversation unread count
    await query(
      `UPDATE conversations SET "unreadCount" = 0 WHERE id = $1`,
      [id]
    );
    
    // Fetch updated conversation
    const result = await query(`SELECT * FROM conversations WHERE id = $1`, [id]);
    
    // Emit via Socket.IO
    if (req.io && result.rows.length > 0) {
      req.io.emit('conversation_updated', result.rows[0]);
    }
    
    res.json({ ok: true, conversation: result.rows[0] });
  } catch (error) {
    logger.error('Error marking conversation as read:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * API health check
 */
router.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

export default router;
