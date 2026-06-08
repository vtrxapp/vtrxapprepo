// ─────────────────────────────────────────────────────────────────────────────
// server.js — VTRX Backend API Server v2.0
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

// ── Required environment variable guard ───────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL', 'CLERK_SECRET_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('FATAL: Missing required environment variables:', missing.join(', '));
  process.exit(1);
}
if ((process.env.JWT_SECRET || '').length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const logger           = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');

// ── Routes ─────────────────────────────────────────────────────────────────
const authRoutes          = require('./routes/auth');
const userRoutes          = require('./routes/users');
const workoutRoutes       = require('./routes/workouts');
const nutritionRoutes     = require('./routes/nutrition');
const paymentRoutes       = require('./routes/payments');
const notificationRoutes  = require('./routes/notifications');
const aiRoutes            = require('./routes/ai');
const uploadRoutes        = require('./routes/upload');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

// Only allow Vercel deployments that are actually ours (start with vtrxapp)
const ALLOWED_VERCEL = /^https:\/\/vtrxapp[a-z0-9-]*\.vercel\.app$/;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // mobile apps, Postman, curl
    if (allowedOrigins.includes(origin) || ALLOWED_VERCEL.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  message: { success: false, message: 'Too many requests. Try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
});

app.use('/api/', limiter);
app.use('/api/auth/login',          authLimiter);
app.use('/api/auth/signup',         authLimiter);
app.use('/api/auth/confirm-email',  authLimiter);
app.use('/api/auth/resend-code',    authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);

// ── CRITICAL: Stripe webhook needs raw body ───────────────────────────────────
// Must be registered BEFORE express.json() parses the body
app.use('/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    req.rawBody = req.body;
    next();
  }
);

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());
app.use(morgan(
  process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
  { stream: { write: (msg) => logger.info(msg.trim()) } }
));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'healthy',
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version:     '2.0.0',
  });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/workouts',      workoutRoutes);
app.use('/api/nutrition',     nutritionRoutes);
app.use('/api/payments',      paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/ai',            aiRoutes);
app.use('/api/upload',        uploadRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info(`🚀 VTRX API v2.0 on port ${PORT} [${process.env.NODE_ENV}]`);
  logger.info(`📡 Health: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down gracefully');
  server.close(() => {
    require('./config/database').$disconnect();
    process.exit(0);
  });
});

module.exports = app;
