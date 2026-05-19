// ─────────────────────────────────────────────────────────────────────────────
// middleware/errorHandler.js — Global Error Handler
// ─────────────────────────────────────────────────────────────────────────────
// This catches ANY unhandled error from any route.
// Instead of crashing or leaking internal details, it returns clean JSON.
// ─────────────────────────────────────────────────────────────────────────────

const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  // Log the full error internally (goes to CloudWatch in production)
  logger.error(`${err.message}`, {
    stack:  err.stack,
    url:    req.originalUrl,
    method: req.method,
    userId: req.user?.id || 'unauthenticated',
  });

  // Prisma-specific errors (database issues)
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      message: 'A record with this value already exists',
    });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      message: 'Record not found',
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  // Default: 500 Internal Server Error
  // NEVER expose internal error details in production
  res.status(err.statusCode || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong. Please try again.'
      : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// Creates a clean error with a status code
const createError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

module.exports = { errorHandler, createError };
