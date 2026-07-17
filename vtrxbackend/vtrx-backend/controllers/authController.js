// ─────────────────────────────────────────────────────────────────────────────
// controllers/authController.js — Authentication Controller
// ─────────────────────────────────────────────────────────────────────────────
// Actual signup/login/verification/password-reset all happen client-side via
// Clerk's own hosted UI (@clerk/clerk-react) — the frontend never calls a
// custom /auth/signup|login|... endpoint. What's left here just reads/mutates
// the Prisma user record once `middleware/auth.js` has already verified the
// caller's Clerk session token.
// ─────────────────────────────────────────────────────────────────────────────

const prisma = require('../config/database');
const clerk  = require('../services/clerkService');
const logger = require('../utils/logger');
const { validationResult } = require('express-validator');

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        subscription: true,
        _count: { select: { workoutLogs: true, savedWorkouts: true, savedMeals: true } },
      },
    });
    res.json({ success: true, data: { user } });
  } catch (error) {
    logger.error('getMe error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
};

// ── POST /api/auth/change-password (protected) ────────────────────────────────
const changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Current and new password are required.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    await clerk.changePassword({ userId: user.cognitoId, currentPassword, newPassword });
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    if (error.name === 'NotAuthorizedException') {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }
    if (error.name === 'InvalidPasswordException') {
      return res.status(400).json({ success: false, message: error.message || 'Password does not meet requirements.' });
    }
    logger.error('changePassword error:', error);
    res.status(500).json({ success: false, message: 'Failed to update password.' });
  }
};

module.exports = { getMe, changePassword };
