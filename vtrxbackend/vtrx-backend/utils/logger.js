// ─────────────────────────────────────────────────────────────────────────────
// utils/logger.js — Application Logger (CloudWatch-ready)
// ─────────────────────────────────────────────────────────────────────────────
// Winston is a logging library. We use it instead of console.log because:
// 1. It formats logs as JSON → AWS CloudWatch can parse and search them
// 2. Different log levels (info, warn, error) for filtering
// 3. Timestamps on every log entry
// 4. In production, logs go to CloudWatch automatically via stdout
// ─────────────────────────────────────────────────────────────────────────────

const winston = require('winston');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom format for development — human-readable coloured output
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack }) => {
    return stack
      ? `${timestamp} [${level}] ${message}\n${stack}`
      : `${timestamp} [${level}] ${message}`;
  })
);

// JSON format for production — CloudWatch can index and search this
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    // In production you could add a file transport or CloudWatch transport
  ],
});

module.exports = logger;
