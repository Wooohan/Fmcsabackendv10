import express from 'express';
import { query } from '../services/db.js';
import logger from '../utils/logger.js';

const router = express.Router();

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'my_secret_123';

/**
 * Facebook Webhook Verification (GET)
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    logger.error('Webhook verification failed');
    res.status(403).send('Verification failed');
  }
});

/**
 * Facebook Webhook Event Handler (POST)
 * Receives events, stores in PostgreSQL, emits via Socket.IO
 */
router.post('/', async (req, res) => {
  const body = req.body;

  // Respond immediately to Facebook (required within 20 seconds)
  res.status(200).send('EVENT_RECEIVED');

  if (body.object === 'page') {
    try {
      for (const entry of body.entry) {
        if (!entry.messaging) continue;
        const webhookEvent = entry.messaging[0];
        if (!webhookEvent) continue;

        const senderId = webhookEvent.sender.id;
        const recipientId = webhookEvent.recipient.id;
        const pageId = recipientId;

        if (webhookEvent.message) {
          await handleMessage(webhookEvent, pageId, senderId, req.io);
        } else if (webhookEvent.delivery) {
          await handleDelivery(webhookEvent);
        } else if (webhookEvent.read) {
          await handleRead(webhookEvent);
        }
      }
    } catch (error) {
      logger.error('Error processing webhook event:', error);
    }
  }
});

/**
 * Fetch the customer's name and profile picture from Facebook Graph API.
 * Uses the page access token stored in the DB for the given pageId.
 */
async function fetchCustomerProfile(customerId, pageId) {
  try {
    // Get the page's access token from DB
    const pageResult = await query(`SELECT "accessToken" FROM pages WHERE id = $1`, [pageId]);
    if (pageResult.rows.length === 0 || !pageResult.rows[0].accessToken) {
      return { name: `User ${customerId.substring(0, 8)}`, avatarUrl: '' };
    }

    const accessToken = pageResult.rows[0].accessToken;
    const url = `https://graph.facebook.com/v22.0/${customerId}?fields=name,picture.type(large)&access_token=${accessToken}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      logger.warn('Failed to fetch customer profile:', data.error.message);
      return { name: `User ${customerId.substring(0, 8)}`, avatarUrl: '' };
    }

    return {
      name: data.name || `User ${customerId.substring(0, 8)}`,
      avatarUrl: data.picture?.data?.url || '',
    };
  } catch (err) {
    logger.warn('Error fetching customer profile:', err.message);
    return { name: `User ${customerId.substring(0, 8)}`, avatarUrl: '' };
  }
}

async function handleMessage(event, pageId, senderId, io) {
  const message = event.message;
  if (!message.text) return;

  try {
    const messageId = message.mid;
    const messageText = message.text;
    const timestamp = new Date(event.timestamp).toISOString();

    // Check/create conversation
    const convResult = await query(
      `SELECT id, "customerName", "customerAvatar" FROM conversations WHERE "customerId" = $1 AND "pageId" = $2 LIMIT 1`,
      [senderId, pageId]
    );

    let conversationId;
    let customerName = `User ${senderId.substring(0, 8)}`;
    let customerAvatar = '';

    if (convResult.rows.length === 0) {
      // New conversation — fetch customer profile from Facebook
      const profile = await fetchCustomerProfile(senderId, pageId);
      customerName = profile.name;
      customerAvatar = profile.avatarUrl;

      conversationId = `${pageId}_${senderId}`;
      await query(
        `INSERT INTO conversations (id, "pageId", "customerId", "customerName", "customerAvatar", "lastMessage", "lastTimestamp", status, "assignedAgentId", "unreadCount")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', NULL, 1)
         ON CONFLICT (id) DO UPDATE SET "lastMessage" = $6, "lastTimestamp" = $7, "unreadCount" = conversations."unreadCount" + 1, "customerName" = $4, "customerAvatar" = $5`,
        [conversationId, pageId, senderId, customerName, customerAvatar, messageText, timestamp]
      );
      logger.info('New conversation created with profile:', conversationId, customerName);
    } else {
      conversationId = convResult.rows[0].id;
      customerName = convResult.rows[0].customerName || customerName;
      customerAvatar = convResult.rows[0].customerAvatar || '';

      // If avatar is missing, try to fetch it
      if (!customerAvatar) {
        const profile = await fetchCustomerProfile(senderId, pageId);
        customerName = profile.name || customerName;
        customerAvatar = profile.avatarUrl;

        await query(
          `UPDATE conversations SET "lastMessage" = $1, "lastTimestamp" = $2, "unreadCount" = "unreadCount" + 1, "customerName" = $3, "customerAvatar" = $4 WHERE id = $5`,
          [messageText, timestamp, customerName, customerAvatar, conversationId]
        );
      } else {
        await query(
          `UPDATE conversations SET "lastMessage" = $1, "lastTimestamp" = $2, "unreadCount" = "unreadCount" + 1 WHERE id = $3`,
          [messageText, timestamp, conversationId]
        );
      }
    }

    // Store message
    await query(
      `INSERT INTO messages (id, "conversationId", "senderId", "senderName", text, timestamp, "isIncoming", "isRead")
       VALUES ($1, $2, $3, $4, $5, $6, true, false)
       ON CONFLICT (id) DO NOTHING`,
      [messageId, conversationId, senderId, customerName, messageText, timestamp]
    );

    const newMessage = {
      id: messageId,
      conversationId,
      senderId,
      senderName: customerName,
      text: messageText,
      timestamp,
      isIncoming: true,
      isRead: false,
    };

    // Push to all connected clients via Socket.IO
    if (io) {
      io.emit('new_message', newMessage);

      // Also emit conversation update
      const convData = await query(`SELECT * FROM conversations WHERE id = $1`, [conversationId]);
      if (convData.rows.length > 0) {
        io.emit('conversation_updated', convData.rows[0]);
      }
    }

    logger.info('Message stored and pushed:', messageId);
  } catch (error) {
    logger.error('Error handling message:', error);
  }
}

async function handleDelivery(event) {
  const messageIds = event.delivery?.mids;
  if (messageIds && messageIds.length > 0) {
    try {
      const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(', ');
      await query(`UPDATE messages SET "isRead" = true WHERE id IN (${placeholders})`, messageIds);
    } catch (error) {
      logger.error('Error updating delivery status:', error);
    }
  }
}

async function handleRead(event) {
  const watermark = event.read?.watermark;
  if (watermark) {
    try {
      await query(
        `UPDATE messages SET "isRead" = true WHERE timestamp <= $1 AND "isRead" = false`,
        [new Date(watermark).toISOString()]
      );
    } catch (error) {
      logger.error('Error updating read status:', error);
    }
  }
}

export default router;
