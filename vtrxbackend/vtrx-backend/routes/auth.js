const express  = require('express');
const { body } = require('express-validator');
const auth     = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/auth/me (protected) ─────────────────────────────────────────────
router.get('/me', protect, auth.getMe);

// ── POST /api/auth/change-password (protected) ───────────────────────────────
router.post('/change-password',
  protect,
  [
    body('currentPassword').notEmpty().withMessage('Current password required'),
    body('newPassword').isLength({ min: 8 })
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage('Password needs uppercase, lowercase and a number'),
  ],
  auth.changePassword
);

module.exports = router;
