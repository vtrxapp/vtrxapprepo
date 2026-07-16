const express  = require('express');
const { body } = require('express-validator');
const support  = require('../controllers/supportController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// ── POST /api/support/message ─────────────────────────────────────────────────
router.post('/message',
  [
    body('message').trim().notEmpty().withMessage('Message is required')
      .isLength({ max: 2000 }).withMessage('Message must be 2000 characters or fewer'),
  ],
  support.sendMessage
);

module.exports = router;
