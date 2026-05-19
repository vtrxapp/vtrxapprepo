// ─────────────────────────────────────────────────────────────────────────────
// config/database.js — Prisma Database Client
// ─────────────────────────────────────────────────────────────────────────────
// Prisma is our ORM (Object-Relational Mapper).
// It lets us talk to PostgreSQL using JavaScript objects instead of raw SQL.
//
// We create ONE instance and reuse it everywhere.
// This is called the "singleton pattern" — it prevents you from accidentally
// opening thousands of database connections.
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');

// Create the Prisma client
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'info', 'warn', 'error']  // Show all DB queries in dev
    : ['error'],                           // Only errors in production
});

// Test the connection when the app starts
prisma.$connect()
  .then(() => console.log('✅ Database connected'))
  .catch((err) => {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1); // Stop the server if DB is unreachable
  });

module.exports = prisma;
