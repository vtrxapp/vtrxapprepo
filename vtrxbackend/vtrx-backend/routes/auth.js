// ─────────────────────────────────────────────────────────────────────────────
// routes/auth.js — Authentication Routes
// ─────────────────────────────────────────────────────────────────────────────
// Routes define which URL + HTTP method maps to which controller function.
// We also add validation here so bad data never reaches the controller.
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const { body } = require('express-validator');
const auth     = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// normalizeEmail options: lowercase only — do NOT strip Gmail dots or subaddresses.
// Stripping dots causes john.doe@gmail.com → johndoe@gmail.com which can break
// lookup if the stored email was never normalised that aggressively.
const NE_OPTS = { gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true };

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup',
  [
    body('email').isEmail().normalizeEmail(NE_OPTS).withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password needs uppercase, lowercase and a number'),
    body('username').isLength({ min: 3, max: 30 }).trim()
      .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers and underscores'),
    body('name').optional().trim().isLength({ min: 1, max: 100 }),
  ],
  auth.signup
);

// ── POST /api/auth/confirm-email ──────────────────────────────────────────────
router.post('/confirm-email',
  [
    body('email').isEmail().normalizeEmail(NE_OPTS),
    body('code').isLength({ min: 6, max: 6 }).withMessage('Code must be 6 digits'),
  ],
  auth.confirmEmail
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(NE_OPTS),
    body('password').notEmpty().withMessage('Password required'),
  ],
  auth.login
);

// ── POST /api/auth/logout (protected) ────────────────────────────────────────
router.post('/logout', protect, auth.logout);

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post('/resend-code',
  [body('email').isEmail().normalizeEmail(NE_OPTS)],
  auth.resendVerificationCode
);
router.post('/forgot-password',
  [body('email').isEmail().normalizeEmail(NE_OPTS)],
  auth.forgotPassword
);

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
router.post('/reset-password',
  [
    body('email').isEmail().normalizeEmail(NE_OPTS),
    body('code').notEmpty(),
    body('newPassword').isLength({ min: 8 })
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  ],
  auth.resetPassword
);

// ── GET /api/auth/me (protected) ─────────────────────────────────────────────
router.get('/me', protect, auth.getMe);

module.exports = router;
