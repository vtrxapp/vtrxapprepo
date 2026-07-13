const crypto = require('crypto');
const logger = require('../utils/logger');
const prisma  = require('../config/database');

// Verify Linear webhook signature — HMAC-SHA256 over the raw request body
// using the signing secret from Linear's webhook settings, compared
// timing-safe, plus a replay window on the payload's webhookTimestamp.
// https://linear.app/developers/webhooks
//
// The window is 5 minutes, not Linear's documented 60s: 60s protects against
// replay just as well for our purposes, but Linear's own retry backoff on a
// failed delivery (we ACK late, we're mid-deploy, a transient 5xx) can easily
// exceed 60s — and a retry replays the ORIGINAL webhookTimestamp, so a tight
// window means every retry of an already-slow delivery fails forever, not
// just the first attempt.
const LINEAR_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const verifyLinearWebhook = (req) => {
  const signature = req.headers['linear-signature'];
  const secret    = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret)      { logger.warn('Linear webhook rejected: LINEAR_WEBHOOK_SECRET not configured'); return false; }
  if (!signature)    { logger.warn('Linear webhook rejected: missing linear-signature header'); return false; }
  if (!req.rawBody)  { logger.warn('Linear webhook rejected: no raw body captured for this request'); return false; }

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    logger.warn('Linear webhook rejected: signature mismatch');
    return false;
  }

  // Accept a numeric string too — be permissive about the exact JSON type
  // Linear serializes this as, since the signature already proves the
  // payload is authentic and unmodified.
  const webhookTimestamp = Number(req.body?.webhookTimestamp);
  if (!Number.isFinite(webhookTimestamp) || Math.abs(Date.now() - webhookTimestamp) > LINEAR_REPLAY_WINDOW_MS) {
    logger.warn('Linear webhook rejected: missing or stale webhookTimestamp');
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
    logger.error(`Linear webhook processing error: ${err.message}`);
  }
};

module.exports = { handleWebhook };
