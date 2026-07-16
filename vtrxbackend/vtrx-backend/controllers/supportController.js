// ─────────────────────────────────────────────────────────────────────────────
// controllers/supportController.js — Support Contact Controller
// ─────────────────────────────────────────────────────────────────────────────

const logger  = require('../utils/logger');
const { validationResult } = require('express-validator');
const { sendSupportMessage } = require('../services/emailService');

// ── POST /api/support/message (protected) ────────────────────────────────────
const sendMessage = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
  }

  try {
    await sendSupportMessage({
      userEmail: req.user.email,
      userName:  req.user.name,
      userId:    req.user.id,
      message:   req.body.message.trim(),
    });
    res.json({ success: true, message: 'Message sent.' });
  } catch (error) {
    logger.error('sendSupportMessage error:', error.message);
    res.status(503).json({ success: false, message: 'Could not send your message right now. Please try again shortly.' });
  }
};

module.exports = { sendMessage };
