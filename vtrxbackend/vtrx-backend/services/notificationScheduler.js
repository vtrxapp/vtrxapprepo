// ─────────────────────────────────────────────────────────────────────────────
// services/notificationScheduler.js — Smart Push Notification Scheduler
// ─────────────────────────────────────────────────────────────────────────────
// Runs a cron job every 15 minutes that evaluates each user's notification
// windows and fires the appropriate push if conditions are met.
//
// Notification types:
//   1. workout_reminder   — daily at user's preferred hour (default 8am)
//   2. streak_alert       — 6pm if streak ≥ 3 days and no workout today
//   3. reengagement       — 5 days inactive, max once per 7 days
//   4. comeback           — 7+ days inactive, 15-min bodyweight workout
//   5. milestone          — 1st/5th/10th workout; 7/30-day streak; 30-day member
//   6. weekly_recap       — Sunday at 10am if ≥ 1 workout this week
//   7. trial_expiry       — 3 days and 24 hours before trial ends
//   8. onboarding         — 5 min after signup: "Your AI analysis is ready"
// ─────────────────────────────────────────────────────────────────────────────

const cron   = require('node-cron');
const prisma = require('../config/database');
const notif  = require('./notificationService');
const logger = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns current hour (0-23) in the user's timezone
const localHour = (timezone) => {
  try {
    return parseInt(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone })
        .format(new Date()),
      10
    );
  } catch {
    return new Date().getUTCHours();
  }
};

// Returns current day of week (0=Sun…6=Sat) in the user's timezone
const localDayOfWeek = (timezone) => {
  try {
    return parseInt(
      new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone })
        .format(new Date())
        .replace(/Sun/, '0').replace(/Mon/, '1').replace(/Tue/, '2')
        .replace(/Wed/, '3').replace(/Thu/, '4').replace(/Fri/, '5').replace(/Sat/, '6'),
      10
    );
  } catch {
    return new Date().getUTCDay();
  }
};

// Start-of-today in a given timezone (as UTC Date)
const startOfTodayInTz = (timezone) => {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      timeZone: timezone,
    }).formatToParts(now);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
  } catch {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
};

// Atomically claim a notification slot. Returns true if this caller "won" the slot
// (should send), false if another instance already claimed it (skip send).
// Uses a unique DB constraint on (userId, type, date) to prevent races across
// multiple instances of this service that each run their own cron.
const claimSend = async (userId, type) => {
  const date = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
  try {
    await prisma.notificationLog.create({ data: { userId, type, date } });
    return true; // We claimed it — go ahead and send
  } catch (e) {
    if (e.code === 'P2002') return false; // Another instance already claimed this slot
    logger.error(`claimSend unexpected error (userId=${userId} type=${type}):`, e.message);
    return false;
  }
};

// Keep for backward compat (milestones use yearly windows, not daily)
const alreadySentWithin = async (userId, type, hours) => {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const found = await prisma.notificationLog.findFirst({
    where: { userId, type, sentAt: { gte: cutoff } },
  });
  return !!found;
};

// Log a sent notification (used by milestone checker which manages its own date key)
const logSent = async (userId, type, date) => {
  const d = date || new Date().toISOString().slice(0, 10);
  await prisma.notificationLog.create({ data: { userId, type, date: d } }).catch(() => {});
};

// ── Comeback workout generator ────────────────────────────────────────────────
// Returns a lightweight bodyweight workout tailored one level below the user's usual level
const buildComebackWorkout = (fitnessLevel) => {
  const level = (fitnessLevel || 'Beginner').toLowerCase();
  const exercises =
    level === 'advanced'      ? ['Push-Ups', 'Bodyweight Squats', 'Plank', 'Glute Bridges', 'Mountain Climbers'] :
    level === 'intermediate'  ? ['Knee Push-Ups', 'Bodyweight Squats', 'Plank Hold', 'Glute Bridges', 'Step-Ups'] :
                                ['Wall Push-Ups', 'Chair Squats', 'Seated Leg Raises', 'Glute Bridges', 'Slow March'];

  return {
    name: '🙌 Welcome Back Session',
    duration: 15,
    type: 'BODYWEIGHT',
    difficulty: level === 'advanced' ? 'Intermediate' : 'Beginner',
    exercises,
    description: 'A gentle 15-minute session to ease you back in. No equipment needed.',
  };
};

// ── Individual notification runners ──────────────────────────────────────────

const runWorkoutReminder = async (user, prefs) => {
  if (!prefs.workoutReminderOn) return;
  const hour = localHour(prefs.timezone);
  if (hour !== prefs.workoutReminderHour) return;

  // Only send if user hasn't logged a workout today
  const todayStart = startOfTodayInTz(prefs.timezone);
  const todayLog = await prisma.workoutLog.findFirst({
    where: { userId: user.id, completedAt: { gte: todayStart } },
  });
  if (todayLog) return;

  // Atomic claim — if another instance already claimed this slot, skip
  if (!(await claimSend(user.id, 'workout_reminder'))) return;

  const name = user.name?.split(' ')[0] || 'there';
  await notif.sendToUser({
    userId: user.id,
    title: '💪 Time to train',
    body: `Hey ${name}, your workout window is open. Even 15 minutes counts.`,
    data: { type: 'workout_reminder', screen: 'Workouts' },
  });
};

const runStreakAlert = async (user, prefs) => {
  if (!prefs.streakAlertOn) return;
  if ((user.streakDays || 0) < 3) return;
  const hour = localHour(prefs.timezone);
  if (hour !== 18) return; // 6pm check

  const todayStart = startOfTodayInTz(prefs.timezone);
  const todayLog = await prisma.workoutLog.findFirst({
    where: { userId: user.id, completedAt: { gte: todayStart } },
  });
  if (todayLog) return;

  if (!(await claimSend(user.id, 'streak_alert'))) return;

  const streak = user.streakDays;
  await notif.sendToUser({
    userId: user.id,
    title: `🔥 ${streak}-day streak — don't break it now`,
    body: `You've been consistent for ${streak} days. One quick session keeps it alive.`,
    data: { type: 'streak_alert', streakDays: String(streak), screen: 'Workouts' },
  });
};

const runReengagement = async (user, prefs) => {
  if (!prefs.reengagementOn) return;
  if (await alreadySentWithin(user.id, 'reengagement', 7 * 24)) return;

  const fiveDaysAgo  = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const lastLog = await prisma.workoutLog.findFirst({
    where: { userId: user.id },
    orderBy: { completedAt: 'desc' },
  });
  if (!lastLog) return;
  if (lastLog.completedAt > fiveDaysAgo || lastLog.completedAt <= sevenDaysAgo) return;

  if (!(await claimSend(user.id, 'reengagement'))) return;

  const name = user.name?.split(' ')[0] || 'there';
  await notif.sendToUser({
    userId: user.id,
    title: '👋 Miss you, ' + name,
    body: "Life happens — no judgement. Your progress is still here whenever you're ready.",
    data: { type: 'reengagement', screen: 'Home' },
  });
};

const runComeback = async (user, prefs) => {
  if (!prefs.reengagementOn) return;
  if (await alreadySentWithin(user.id, 'comeback', 7 * 24)) return;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const lastLog = await prisma.workoutLog.findFirst({
    where: { userId: user.id },
    orderBy: { completedAt: 'desc' },
  });
  if (!lastLog || lastLog.completedAt > sevenDaysAgo) return;

  if (!(await claimSend(user.id, 'comeback'))) return;

  const totalWorkouts = await prisma.workoutLog.count({ where: { userId: user.id } });
  const totalCalories = await prisma.workoutLog.aggregate({
    where: { userId: user.id },
    _sum: { caloriesBurned: true },
  });
  const totalKcal = totalCalories._sum.caloriesBurned || 0;
  const workout = buildComebackWorkout(user.fitnessLevel);

  await notif.sendToUser({
    userId: user.id,
    title: "🏃 Your comeback starts today",
    body: `${totalWorkouts} sessions, ${totalKcal} kcal burned — that's real. We saved a 15-min session for you.`,
    data: { type: 'comeback', workoutJson: JSON.stringify(workout), screen: 'Workouts' },
  });
};

const runWeeklyRecap = async (user, prefs) => {
  if (!prefs.weeklyRecapOn) return;
  const dow  = localDayOfWeek(prefs.timezone);
  const hour = localHour(prefs.timezone);
  if (dow !== 0 || hour !== 10) return; // Sunday 10am only

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const logs = await prisma.workoutLog.findMany({
    where: { userId: user.id, completedAt: { gte: weekAgo } },
    select: { caloriesBurned: true, duration: true },
  });
  if (logs.length === 0) return;

  if (!(await claimSend(user.id, 'weekly_recap'))) return;

  const totalKcal = logs.reduce((s, l) => s + (l.caloriesBurned || 0), 0);
  const totalMins = logs.reduce((s, l) => s + (l.duration || 0), 0);

  await notif.sendToUser({
    userId: user.id,
    title: '📊 Your week in review',
    body: `${logs.length} workout${logs.length === 1 ? '' : 's'}, ${totalMins} min, ${totalKcal} kcal — solid week.`,
    data: { type: 'weekly_recap', screen: 'Progress' },
  });
};

const runTrialWarning = async (user, prefs) => {
  if (!prefs.trialWarningOn) return;
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  if (!sub || !sub.currentPeriodEnd || sub.status !== 'active') return;
  if (sub.plan !== 'free') return; // only trials

  const daysLeft = (sub.currentPeriodEnd - Date.now()) / (24 * 60 * 60 * 1000);

  if (daysLeft > 3 || daysLeft < 0) return;

  const key = daysLeft <= 1 ? 'trial_expiry_24h' : 'trial_expiry_3d';
  if (await alreadySentWithin(user.id, key, 20)) return;

  const body = daysLeft <= 1
    ? 'Your free trial ends in less than 24 hours. Upgrade to keep all your progress.'
    : `Your free trial ends in ${Math.ceil(daysLeft)} days. Upgrade now to keep Premium access.`;

  await notif.sendToUser({
    userId: user.id,
    title: '⏰ Trial ending soon',
    body,
    data: { type: key, screen: 'Settings' },
  });
  await logSent(user.id, key);
};

// ── Milestone checker (called directly from logWorkout, not on schedule) ──────

const checkMilestones = async (userId) => {
  try {
    const prefs = await getOrCreatePrefs(userId);
    if (!prefs.milestoneOn) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, streakDays: true, createdAt: true },
    });
    if (!user) return;

    const totalWorkouts = await prisma.workoutLog.count({ where: { userId } });

    // Workout count milestones
    const countMilestones = { 1: '🎉 First workout done!', 5: '⭐ 5 workouts in!', 10: '🏆 10 workouts — legend!' };
    if (countMilestones[totalWorkouts]) {
      const key = `milestone_workout_${totalWorkouts}`;
      if (!(await alreadySentWithin(userId, key, 24 * 365))) {
        await notif.sendToUser({
          userId,
          title: countMilestones[totalWorkouts],
          body: `You've completed ${totalWorkouts} workout${totalWorkouts === 1 ? '' : 's'} with VTRX. Keep building.`,
          data: { type: key, screen: 'Progress' },
        });
        await logSent(userId, key);
      }
    }

    // Streak milestones
    const streak = user.streakDays || 0;
    const streakMilestones = { 7: '🔥 7-day streak!', 30: '🔥🔥 30-day streak!' };
    if (streakMilestones[streak]) {
      const key = `milestone_streak_${streak}`;
      if (!(await alreadySentWithin(userId, key, 24 * 365))) {
        await notif.sendToUser({
          userId,
          title: streakMilestones[streak],
          body: `${streak} days straight — that's elite consistency.`,
          data: { type: key, screen: 'Progress' },
        });
        await logSent(userId, key);
      }
    }

    // 30-day member milestone
    const memberDays = Math.floor((Date.now() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    if (memberDays >= 30) {
      const key = 'milestone_member_30d';
      if (!(await alreadySentWithin(userId, key, 24 * 365))) {
        await notif.sendToUser({
          userId,
          title: '🎊 30 days with VTRX',
          body: "A month in — you're not just trying, you're committed. That's everything.",
          data: { type: key, screen: 'Progress' },
        });
        await logSent(userId, key);
      }
    }
  } catch (err) {
    logger.error('Milestone check error:', err.message);
  }
};

// ── Preference helpers ────────────────────────────────────────────────────────

const getOrCreatePrefs = async (userId, timezone) => {
  return prisma.notificationPreference.upsert({
    where:  { userId },
    create: { userId, timezone: timezone || 'UTC' },
    update: timezone ? { timezone } : {},
  });
};

// ── Onboarding notification runner ───────────────────────────────────────────

const runOnboardingNotification = async () => {
  try {
    const now = new Date();
    const pending = await prisma.user.findMany({
      where: {
        onboardingNotifyAt: { lte: now },
        onboardingNotifySent: false,
        onboardingAnalysisReady: true,
      },
      select: {
        id: true, name: true,
        deviceTokens: { where: { active: true }, take: 1 },
      },
    });

    for (const user of pending) {
      if (!user.deviceTokens.length) continue;
      // Mark sent first to prevent double-send across instances
      const updated = await prisma.user.updateMany({
        where: { id: user.id, onboardingNotifySent: false },
        data:  { onboardingNotifySent: true },
      });
      if (updated.count === 0) continue; // Another instance already claimed it

      const firstName = user.name?.split(' ')[0] || 'there';
      await notif.sendToUser({
        userId: user.id,
        title:  '🤖 Your AI Coaching analysis is ready',
        body:   `${firstName}, your personalised fitness plan is ready. Tap to view it.`,
        data:   { type: 'onboarding_workout', screen: 'aiSummary' },
      });
      await notif.sendToUser({
        userId: user.id,
        title:  '🥗 Your AI Nutrition analysis is ready',
        body:   'Your personalised nutrition plan based on your goals is ready to view.',
        data:   { type: 'onboarding_nutrition', screen: 'nutritionPlan' },
      });
      logger.info(`Onboarding notifications sent for user ${user.id}`);
    }
  } catch (err) {
    logger.error('runOnboardingNotification error:', err.message);
  }
};

// ── Main scheduler tick ───────────────────────────────────────────────────────

const tick = async () => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, name: true, streakDays: true, fitnessLevel: true,
        createdAt: true,
        notificationPrefs: true,
        deviceTokens: { where: { active: true }, take: 1 },
      },
    });

    // Only process users who have at least one active device token
    const activeUsers = users.filter(u => u.deviceTokens.length > 0);

    for (const user of activeUsers) {
      const prefs = user.notificationPrefs || await getOrCreatePrefs(user.id);

      await runWorkoutReminder(user, prefs);
      await runStreakAlert(user, prefs);
      await runReengagement(user, prefs);
      await runComeback(user, prefs);
      await runWeeklyRecap(user, prefs);
      await runTrialWarning(user, prefs);
    }
  } catch (err) {
    logger.error('Notification scheduler tick error:', err.message);
  }
};

// ── Start the scheduler ───────────────────────────────────────────────────────

const start = () => {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    logger.info('Notification scheduler tick');
    tick();
  });

  // Onboarding notifications — check every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    runOnboardingNotification();
  });

  logger.info('Notification scheduler started (every 15 min)');
};

module.exports = { start, tick, checkMilestones, getOrCreatePrefs, buildComebackWorkout, runOnboardingNotification };
