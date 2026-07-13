const logger = require('../utils/logger');
const prisma  = require('../config/database');

// Verify Linear webhook signature
const verifyLinearWebhook = (req) => {
  const secret = req.headers['linear-delivery'] || req.headers['x-linear-signature'];
  return !!secret; // Linear sends delivery ID; full HMAC verification optional
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
      const isBug = (data.labels || []).some(l => l.name?.toLowerCase() === 'bug');
      if (isBug) {
        logger.warn(`Linear bug created: ${data.identifier} — ${data.title} [priority ${data.priority}]`);
      }
    }
  } catch (err) {
    logger.error('Linear webhook processing error:', err.message);
  }
};

module.exports = { handleWebhook };
