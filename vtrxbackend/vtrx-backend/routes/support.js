const express  = require('express');
const { body } = require('express-validator');
const support  = require('../controllers/supportController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// ── POST /api/support/message ─────────────────────────────────────────────────
router.post('/message',
  [
    // .bail() is required here, not cosmetic — express-validator runs every
    // chained method in sequence regardless of an earlier failure unless told
    // to stop, so without it .trim() below would still execute (and throw) on
    // a non-string payload even though isString() already flagged it invalid.
    body('message').isString().withMessage('Message must be text').bail()
      .trim().notEmpty().withMessage('Message is required')
      .isLength({ max: 2000 }).withMessage('Message must be 2000 characters or fewer'),
  ],
  support.sendMessage
);

module.exports = router;
