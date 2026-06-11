import fetch from 'node-fetch';
import FormData from 'form-data';
import logger from '../utils/logger.js';

/**
 * Convert base64 data URL to Buffer for backend use
 */
const base64ToBuffer = (base64) => {
  const parts = base64.split(',');
  if (parts.length < 2) return null;
  return Buffer.from(parts[1], 'base64');
};

/**
 * Sends an image to a Facebook user using a single multipart request.
 * This is more robust and avoids (#100) parameter missing errors.
 */
export async function sendImageMessage(recipientId, base64Image, pageAccessToken, isWindowExpired = false) {
  try {
    const buffer = base64ToBuffer(base64Image);
    if (!buffer) throw new Error('Invalid base64 image data');

    const url = `https://graph.facebook.com/v22.0/me/messages?access_token=${pageAccessToken}`;
    
    // Construct the message object as required by Meta
    const messagePayload = {
      attachment: {
        type: 'image',
        payload: { is_reusable: true }
      }
    };

    const formData = new FormData();
    formData.append('recipient', JSON.stringify({ id: recipientId }));
    formData.append('message', JSON.stringify(messagePayload));
    formData.append('filedata', buffer, {
      filename: 'image.png',
      contentType: 'image/png'
    });

    if (isWindowExpired) {
      formData.append('messaging_type', 'MESSAGE_TAG');
      formData.append('tag', 'HUMAN_AGENT');
    } else {
      formData.append('messaging_type', 'RESPONSE');
    }

    const response = await fetch(url, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (data.error) {
      logger.error('Facebook image send error:', data.error);
      throw new Error(data.error.message);
    }
    return data;
  } catch (error) {
    logger.error('Failed to send image message:', error);
    throw error;
  }
}
