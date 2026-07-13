// ─────────────────────────────────────────────────────────────────────────────
// services/streakFreezeService.js — Streak Freeze grants, activation, and the
// gap-check updateStreak() uses to decide whether a missed stretch should still
// break the streak. Free users get 1/month, Premium 3/month; unused freezes do
// not carry over — each new calendar month refills to the tier's cap.
//
// All "calendar day" comparisons here use UTC-pinned midnight (toDateOnly), so
// a date read back from the @db.Date column round-trips to the exact same value
// as one built locally — never re-derive a date from a value already read from
// the database using anything other than toDateOnly, or the two can drift.
// ─────────────────────────────────────────────────────────────────────────────

const prisma = require('../config/database');

const FREEZE_CAP = { free: 1, premium: 3 };

const capFor = (user) => (user?.isPremium ? FREEZE_CAP.premium : FREEZE_CAP.free);

// Pins a Date to UTC midnight of its UTC calendar day — idempotent, so it's safe
// to apply to both freshly-built Dates and ones already read back from Postgres.
const toDateOnly = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

// Refills streakFreezesAvailable to the tier's cap once a new calendar month has
// started since the last refill. Use-it-or-lose-it — never tops up mid-month.
const ensureFreezeRefill = async (userId) => {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { isPremium: true, streakFreezesAvailable: true, lastFreezeRefillAt: true },
  });
  const now  = new Date();
  const last = user.lastFreezeRefillAt;
  const needsRefill = !last
    || last.getUTCFullYear() !== now.getUTCFullYear()
    || last.getUTCMonth()    !== now.getUTCMonth();

  if (!needsRefill) return user;

  return prisma.user.update({
    where:  { id: userId },
    data:   { streakFreezesAvailable: capFor(user), lastFreezeRefillAt: now },
    select: { isPremium: true, streakFreezesAvailable: true, lastFreezeRefillAt: true },
  });
};

// GET status — refills first (lazily), then reports the current balance plus
// which dates this month are already frozen (for Dashboard/Weekly Stats/Calendar)
const getFreezeStatus = async (userId) => {
  const user = await ensureFreezeRefill(userId);
  const now  = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextRefill = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const frozen = await prisma.streakFreeze.findMany({
    where:   { userId, date: { gte: monthStart } },
    select:  { date: true },
    orderBy: { date: 'desc' },
  });
  const frozenDates = frozen.map(f => f.date.toISOString().slice(0, 10));
  const todayStr    = toDateOnly(now).toISOString().slice(0, 10);

  return {
    available:   user.streakFreezesAvailable,
    cap:         capFor(user),
    refillsOn:   nextRefill.toISOString(),
    frozenToday: frozenDates.includes(todayStr),
    frozenDates,
  };
};

// POST activate — spends one freeze protecting today's date
const activateFreeze = async (userId) => {
  const user  = await ensureFreezeRefill(userId);
  const today = toDateOnly(new Date());

  const already = await prisma.streakFreeze.findUnique({
    where: { userId_date: { userId, date: today } },
  });
  if (already) {
    const err = new Error('Streak Freeze is already active today');
    err.code  = 'ALREADY_ACTIVE';
    throw err;
  }
  if (user.streakFreezesAvailable <= 0) {
    const err = new Error('No Streak Freezes available this month');
    err.code  = 'NONE_AVAILABLE';
    throw err;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data:  { streakFreezesAvailable: { decrement: 1 } },
    }),
    prisma.streakFreeze.create({ data: { userId, date: today } }),
  ]);

  return getFreezeStatus(userId);
};

// Used by updateStreak() — true only if EVERY calendar day strictly between
// lastActive and now (i.e. the days actually missed) was frozen, meaning the
// gap should not break the streak.
const wasGapFrozen = async (userId, lastActive, now) => {
  const gapStart = toDateOnly(lastActive);
  gapStart.setUTCDate(gapStart.getUTCDate() + 1); // day after last activity
  const gapEnd = toDateOnly(now);
  gapEnd.setUTCDate(gapEnd.getUTCDate() - 1);      // day before now
  if (gapStart > gapEnd) return false; // no full day was actually missed

  const missedDays = [];
  for (let d = new Date(gapStart); d <= gapEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    missedDays.push(d.getTime());
  }

  const frozen = await prisma.streakFreeze.findMany({
    where:  { userId, date: { gte: gapStart, lte: gapEnd } },
    select: { date: true },
  });
  const frozenSet = new Set(frozen.map(f => f.date.getTime())); // already canonical — don't re-normalize
  return missedDays.every(t => frozenSet.has(t));
};

module.exports = { FREEZE_CAP, ensureFreezeRefill, getFreezeStatus, activateFreeze, wasGapFrozen, toDateOnly };
