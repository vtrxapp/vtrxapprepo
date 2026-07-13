const crypto = require('crypto');
const logger = require('../utils/logger');
const prisma  = require('../config/database');

// Verify Linear webhook signature — HMAC-SHA256 over the raw request body
// using the signing secret from Linear's webhook settings, compared
// timing-safe, plus a 60s replay window on the payload's webhookTimestamp.
// https://linear.app/developers/webhooks
const verifyLinearWebhook = (req) => {
  const signature = req.headers['linear-signature'];
  const secret    = process.env.LINEAR_WEBHOOK_SECRET;
  if (!signature || !secret || !req.rawBody) return false;

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  const webhookTimestamp = req.body?.webhookTimestamp;
  if (typeof webhookTimestamp !== 'number' || Math.abs(Date.now() - webhookTimestamp) > 60_000) {
    return false;
  }

  return true;
};

// POST /api/linear/webhook
// Receives Linear issue events — use to sync engineering status into VTRX if needed
const handleWebhook = async (req, res) => {
  if (!verifyLinearWebhook(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorised' });
  }

  const { type, action, data } = req.body;
  res.json({ success: true }); // ACK immediately — Linear expects fast response

  try {
    // Issue moved to "Done" → log it
    if (type === 'Issue' && action === 'update' && data?.state?.name === 'Done') {
      logger.info(`Linear issue completed: ${data.identifier} — ${data.title}`);
    }

    // Issue created with "Bug" label → log for monitoring
    if (type === 'Issue' && action === 'create') {
      const isBug = (data?.labels || []).some(l => l.name?.toLowerCase() === 'bug');
      if (isBug) {
        logger.warn(`Linear bug created: ${data.identifier} — ${data.title} [priority ${data.priority}]`);
      }
    }
  } catch (err) {
    logger.error('Linear webhook processing error:', err.message);
  }
};

module.exports = { handleWebhook };
