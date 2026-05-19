// ─────────────────────────────────────────────────────────────────────────────
// middleware/auth.js — Authentication Middleware
// ─────────────────────────────────────────────────────────────────────────────
// "Middleware" runs BEFORE your route handler.
// This middleware checks: "Is this request coming from a logged-in user?"
//
// How it works:
// 1. User logs in → gets a JWT token (a signed string)
// 2. User sends that token in every request header: "Authorization: Bearer <token>"
// 3. This middleware reads the token, verifies it, attaches user to req.user
// 4. If token is missing or invalid → 401 Unauthorized response
// ─────────────────────────────────────────────────────────────────────────────

const jwt    = require('jsonwebtoken');
const prisma = require('../config/database');
const logger = require('../utils/logger');

// ── Protect a route (user must be logged in) ──────────────────────────────────
const protect = async (req, res, next) => {
  try {
    // 1. Look for token in the Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Not authorised — no token provided',
      });
    }

    // 2. Extract the token (remove "Bearer " prefix)
    const token = authHeader.split(' ')[1];

    // 3. Verify the token using our JWT_SECRET
    //    If the token was tampered with or expired, this throws an error
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 4. Look up the user in the database
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id:          true,
        email:       true,
        username:    true,
        name:        true,
        isPremium:   true,
        cognitoId:   true,
        goal:        true,
        fitnessLevel: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User no longer exists',
      });
    }

    // 5. Attach user to the request object so route handlers can use it
    req.user = user;

    // 6. Continue to the actual route handler
    next();

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired — please log in again',
        code: 'TOKEN_EXPIRED',
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
    }
    logger.error('Auth middleware error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ── Require Premium subscription ─────────────────────────────────────────────
// Use this AFTER protect() to gate premium features
const requirePremium = (req, res, next) => {
  if (!req.user.isPremium) {
    return res.status(403).json({
      success: false,
      message: 'This feature requires a Premium subscription',
      code: 'PREMIUM_REQUIRED',
    });
  }
  next();
};

module.exports = { protect, requirePremium };
