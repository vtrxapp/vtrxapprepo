// ─────────────────────────────────────────────────────────────────────────────
// services/notificationService.js — Firebase Push Notifications
// ─────────────────────────────────────────────────────────────────────────────
// Firebase Cloud Messaging (FCM) sends push notifications to iOS and Android.
//
// How it works:
// 1. When a user installs the app, their device gets a unique FCM token
// 2. The app sends that token to our backend (POST /api/notifications/register)
// 3. We store it in the DeviceToken table
// 4. When we want to notify the user, we call Firebase with their token
// 5. Firebase delivers the notification to the device
//
// SETUP REQUIRED:
// 1. Go to https://console.firebase.google.com
// 2. Create a project called "vtrx-app"
// 3. Add iOS app (bundle ID: com.vtrx.app) and Android app (package: com.vtrx.app)
// 4. Go to Project Settings → Service accounts → Generate new private key
// 5. Download the JSON file
// 6. Base64 encode it: base64 -i firebase-service-account.json
// 7. Paste into FIREBASE_SERVICE_ACCOUNT_BASE64 in your .env
// ─────────────────────────────────────────────────────────────────────────────

const admin  = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const prisma = require('../config/database');
const logger = require('../utils/logger');

// ── Initialise Firebase Admin ──────────────────────────────────────────────────
let firebaseInitialised = false;

const initFirebase = () => {
  if (firebaseInitialised) return;

  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!serviceAccountBase64) {
    logger.warn('Firebase not configured — push notifications disabled');
    return;
  }

  try {
    const serviceAccount = JSON.parse(
      Buffer.from(serviceAccountBase64, 'base64').toString('utf8')
    );

    admin.initializeApp({
      // firebase-admin v14 moved credential.cert() to a top-level export.
      credential: admin.cert(serviceAccount),
    });

    firebaseInitialised = true;
    logger.info('Firebase Admin initialised');
  } catch (err) {
    logger.error(`Firebase init failed: ${err.message}`);
  }
};

// Initialise on module load
initFirebase();

// ── Register Device Token ─────────────────────────────────────────────────────
// Called when a user opens the app and grants notification permission — the
// frontend calls this on every dashboard mount when permission is already
// granted, not just once, so concurrent calls for the same user+platform are
// routine, not a rare edge case.
//
// "Deactivate other tokens, then upsert this one" used to be two separate,
// non-transactional writes: two concurrent calls carrying two different
// (both legitimate) token values could each find no conflicting row yet and
// both end up active, leaving the user with 2 live tokens for the same
// platform — sendToUser fans out to every active token, so every push after
// that was silently delivered twice. An advisory lock (rather than a DB
// unique constraint on [userId, platform]) closes this without a schema
// migration, which would fail deploy on any account already carrying
// duplicate rows from this bug.
const registerToken = async ({ userId, token, platform }) => {
  await prisma.$transaction(async (tx) => {
    // Serialises concurrent registrations for the same user+platform so they
    // can never interleave — held for the transaction's lifetime, released
    // automatically on commit/rollback.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId} || ':' || ${platform})::bigint)`;

    await tx.deviceToken.updateMany({
      where: { userId, platform, active: true, NOT: { token } },
      data:  { active: false },
    });
    await tx.deviceToken.upsert({
      where:  { token },
      create: { userId, token, platform, active: true },
      update: { userId, active: true, updatedAt: new Date() },
    });
  });
  logger.info(`Device token registered for user ${userId} (${platform})`);
};

// ── Remove Device Token ────────────────────────────────────────────────────────
// Called on logout or when user disables notifications
const removeToken = async (userId, token) => {
  // Scoped to the requesting user — without this, any authenticated caller
  // could pass someone else's device token and silently deactivate it.
  await prisma.deviceToken.updateMany({
    where: { userId, token },
    data:  { active: false },
  });
};

// ── Send to One User ───────────────────────────────────────────────────────────
const sendToUser = async ({ userId, title, body, data = {}, imageUrl }) => {
  if (!firebaseInitialised) {
    logger.warn('Firebase not initialised — skipping push notification');
    return { sent: 0 };
  }

  // Get all active device tokens for this user
  const tokens = await prisma.deviceToken.findMany({
    where:  { userId, active: true },
    select: { token: true, platform: true },
  });

  if (tokens.length === 0) {
    logger.info(`No active device tokens for user ${userId}`);
    return { sent: 0 };
  }

  const results = await Promise.allSettled(
    tokens.map(({ token, platform }) =>
      getMessaging().send({
        token,
        notification: {
          title,
          body,
          ...(imageUrl && { imageUrl }),
        },
        data: {
          // All data values must be strings for FCM
          ...Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)])
          ),
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
        // iOS-specific settings
        apns: {
          payload: {
            aps: {
              sound:  'default',
              badge:  1,
              category: data.type || 'general',
            },
          },
        },
        // Android-specific settings
        android: {
          notification: {
            sound:       'default',
            channelId:   'vtrx_default',
            priority:    'high',
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          },
          priority: 'high',
        },
      }).catch(async (err) => {
        // If token is invalid, deactivate it
        if (
          err.code === 'messaging/registration-token-not-registered' ||
          err.code === 'messaging/invalid-registration-token'
        ) {
          await prisma.deviceToken.updateMany({
            where: { token },
            data:  { active: false },
          });
          logger.info(`Deactivated invalid token for user ${userId}`);
        }
        throw err;
      })
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;

  // Persist a record so the in-app notification feed can show it
  await prisma.notification.create({
    data: {
      userId,
      type:  data.type || 'general',
      title,
      body,
      data:  data || {},
    },
  }).catch(() => {});

  // Delete this user's notifications older than 24 hours — scoped to userId,
  // since this runs on every send and an unscoped delete would purge every
  // other user's notification feed too.
  await prisma.notification.deleteMany({
    where: { userId, createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  }).catch(() => {});

  logger.info(`Push notification sent to user ${userId}: ${succeeded} success, ${failed} failed`);
  return { sent: succeeded, failed };
};

// ── Send to Multiple Users ─────────────────────────────────────────────────────
const sendToUsers = async (userIds, notification) => {
  const results = await Promise.allSettled(
    userIds.map(userId => sendToUser({ userId, ...notification }))
  );
  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// PRE-BUILT NOTIFICATION TYPES
// ─────────────────────────────────────────────────────────────────────────────

// Workout reminder
const sendWorkoutReminder = async ({ userId, workoutName, time }) => {
  await sendToUser({
    userId,
    title: '💪 Time to train',
    body:  `Your ${workoutName} session is scheduled. Let's go.`,
    data:  { type: 'workout_reminder', workoutName },
  });
};

// AI summary ready
const sendAISummaryReady = async ({ userId, workoutName }) => {
  await sendToUser({
    userId,
    title: '🤖 AI Coach Report Ready',
    body:  `Your ${workoutName} analysis is ready. Tap to see your coaching summary.`,
    data:  { type: 'ai_summary', workoutName },
  });
};

// Streak alert
const sendStreakAlert = async ({ userId, streakDays }) => {
  await sendToUser({
    userId,
    title: `🔥 ${streakDays} day streak — keep it alive!`,
    body:  'Log a workout or check in today to maintain your streak.',
    data:  { type: 'streak_alert', streakDays: String(streakDays) },
  });
};

// Streak broken
const sendStreakBroken = async ({ userId }) => {
  await sendToUser({
    userId,
    title: '😔 Streak broken',
    body:  'Your streak ended — but every champion has a comeback. Start a new one today.',
    data:  { type: 'streak_broken' },
  });
};

// Weekly progress summary
const sendWeeklySummary = async ({ userId, workoutsCompleted, caloriesBurned, streakDays }) => {
  await sendToUser({
    userId,
    title: '📊 Your weekly summary is ready',
    body:  `${workoutsCompleted} workouts, ${caloriesBurned} calories burned. ${streakDays} day streak.`,
    data:  { type: 'weekly_summary', workoutsCompleted: String(workoutsCompleted) },
  });
};

// Payment failed
const sendPaymentFailed = async ({ userId }) => {
  await sendToUser({
    userId,
    title: '💳 Payment failed',
    body:  'We could not process your payment. Update your billing details to keep Premium.',
    data:  { type: 'payment_failed' },
  });
};

// Hydration reminder
const sendHydrationReminder = async ({ userId }) => {
  await sendToUser({
    userId,
    title: '💧 Hydration check',
    body:  'Have you hit your water goal today? Stay hydrated for peak performance.',
    data:  { type: 'hydration' },
  });
};

// Meal reminder
const sendMealReminder = async ({ userId, mealName, time }) => {
  await sendToUser({
    userId,
    title: `🥗 ${mealName} time`,
    body:  `It\'s time for your planned ${mealName.toLowerCase()}. Check your meal plan.`,
    data:  { type: 'meal_reminder', mealName },
  });
};

module.exports = {
  registerToken,
  removeToken,
  sendToUser,
  sendToUsers,
  sendWorkoutReminder,
  sendAISummaryReady,
  sendStreakAlert,
  sendStreakBroken,
  sendWeeklySummary,
  sendPaymentFailed,
  sendHydrationReminder,
  sendMealReminder,
};
