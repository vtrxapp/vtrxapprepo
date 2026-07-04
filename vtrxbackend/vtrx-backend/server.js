// ─────────────────────────────────────────────────────────────────────────────
// server.js — VTRX Backend API Server v2.0
// ─────────────────────────────────────────────────────────────────────────────

// Sentry MUST be initialised before any other require so it can instrument them
require('./instrument');
require('dotenv').config();

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
const n8nRoutes           = require('./routes/n8n');
const linearRoutes        = require('./routes/linear');

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

// ALLOWED_VERCEL_ORIGINS (optional, comma-separated list of exact Vercel origin URLs,
// e.g. "https://vtrx-app.vercel.app,https://vtrx-staging.vercel.app").
// When set, ONLY those specific Vercel origins are allowed — the *.vercel.app wildcard
// is disabled. If not set, ANY *.vercel.app subdomain is allowed (legacy behaviour).
const allowedVercelOrigins = process.env.ALLOWED_VERCEL_ORIGINS
  ? process.env.ALLOWED_VERCEL_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

if (!allowedVercelOrigins) {
  logger.warn(
    '[CORS] ALLOWED_VERCEL_ORIGINS is not set — falling back to allowing ANY *.vercel.app ' +
    'origin with credentials. Anyone can deploy a project to a vercel.app subdomain. ' +
    'Set ALLOWED_VERCEL_ORIGINS to your exact production frontend URL(s) to close this.'
  );
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);
    // Check static allowed origins (FRONTEND_URL, localhost)
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Vercel origin check — restricted to specific list when ALLOWED_VERCEL_ORIGINS is set
    if (allowedVercelOrigins) {
      if (allowedVercelOrigins.includes(origin)) return callback(null, true);
    } else if (origin.endsWith('.vercel.app')) {
      // Fallback: allow any *.vercel.app when the env var is not configured
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            200,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, message: 'Too many requests. Try again later.' },
});
const authLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            10,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
});
const aiLimiter = rateLimit({
  windowMs:       60 * 60 * 1000, // 1 hour
  max:            30,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { success: false, message: 'AI request limit reached. Try again in an hour.' },
});

app.use('/api/', limiter);
app.use('/api/ai/',         aiLimiter);
app.use('/api/auth/',       authLimiter);

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
app.use('/api/n8n',           n8nRoutes);
app.use('/api/linear',        linearRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ── Sentry error handler (must be before any other error middleware) ───────────
const Sentry = require('@sentry/node');
Sentry.setupExpressErrorHandler(app);

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info(`🚀 VTRX API v2.0 on port ${PORT} [${process.env.NODE_ENV}]`);
  logger.info(`📡 Health: http://localhost:${PORT}/health`);
  // Background startup tasks — server is already accepting connections
  require('./scripts/syncRecipesFromYmove').run().catch(e => logger.error('Recipe sync error:', e));
  require('./scripts/seedPinecone').run().catch(e => logger.error('Pinecone seed error:', e));
  require('./scripts/cleanupDeviceTokens').run().catch(e => logger.error('Device token cleanup error:', e));
  require('./services/notificationScheduler').start();
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down gracefully');
  server.close(() => {
    require('./config/database').$disconnect();
    process.exit(0);
  });
});

module.exports = app;
