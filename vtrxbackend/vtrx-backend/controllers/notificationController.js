// ─────────────────────────────────────────────────────────────────────────────
// controllers/notificationController.js
// ─────────────────────────────────────────────────────────────────────────────

const notifService  = require('../services/notificationService');
const scheduler     = require('../services/notificationScheduler');
const prisma        = require('../config/database');
const logger        = require('../utils/logger');

// ── POST /api/notifications/register ─────────────────────────────────────────
const registerToken = async (req, res) => {
  const { token, platform, timezone } = req.body;

  if (!token || !platform) {
    return res.status(400).json({ success: false, message: 'Token and platform required' });
  }
  if (!['ios', 'android', 'web'].includes(platform)) {
    return res.status(400).json({ success: false, message: 'Platform must be ios, android, or web' });
  }

  try {
    await notifService.registerToken({ userId: req.user.id, token, platform });

    // Update timezone in preferences if provided
    if (timezone) {
      await scheduler.getOrCreatePrefs(req.user.id, timezone);
    }

    res.json({ success: true, message: 'Device registered for notifications' });
  } catch (err) {
    logger.error('Register token error:', err);
    res.status(500).json({ success: false, message: 'Failed to register device' });
  }
};

// ── DELETE /api/notifications/register ────────────────────────────────────────
const removeToken = async (req, res) => {
  const { token } = req.body;
  try {
    await notifService.removeToken(token);
    res.json({ success: true });
  } catch (err) {
    logger.error('Remove token error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove device' });
  }
};

// ── GET /api/notifications ────────────────────────────────────────────────────
const getNotifications = async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take:    50,
    });
    const unreadCount = notifications.filter(n => !n.read).length;
    res.json({ success: true, data: { notifications, unreadCount } });
  } catch (err) {
    logger.error('Get notifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
};

// ── PATCH /api/notifications/read ─────────────────────────────────────────────
const markAllRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data:  { read: true },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update' });
  }
};

// ── PATCH /api/notifications/:id/read ─────────────────────────────────────────
const markOneRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data:  { read: true },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update' });
  }
};

// ── DELETE /api/notifications/:id ────────────────────────────────────────────
const deleteNotification = async (req, res) => {
  try {
    await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.user.id },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Delete notification error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete notification' });
  }
};

// ── GET /api/notifications/preferences ───────────────────────────────────────
const getPreferences = async (req, res) => {
  try {
    const prefs = await scheduler.getOrCreatePrefs(req.user.id);
    res.json({ success: true, data: { preferences: prefs } });
  } catch (err) {
    logger.error('Get preferences error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch preferences' });
  }
};

// ── PATCH /api/notifications/preferences ─────────────────────────────────────
const updatePreferences = async (req, res) => {
  const allowed = [
    'timezone', 'workoutReminderOn', 'workoutReminderHour',
    'streakAlertOn', 'reengagementOn', 'milestoneOn',
    'weeklyRecapOn', 'trialWarningOn',
  ];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }

  if (update.workoutReminderHour !== undefined) {
    const h = parseInt(update.workoutReminderHour, 10);
    if (isNaN(h) || h < 0 || h > 23) {
      return res.status(400).json({ success: false, message: 'workoutReminderHour must be 0-23' });
    }
    update.workoutReminderHour = h;
  }

  try {
    const prefs = await prisma.notificationPreference.upsert({
      where:  { userId: req.user.id },
      create: { userId: req.user.id, ...update },
      update,
    });
    res.json({ success: true, data: { preferences: prefs } });
  } catch (err) {
    logger.error('Update preferences error:', err);
    res.status(500).json({ success: false, message: 'Failed to update preferences' });
  }
};

// ── POST /api/notifications/test ─────────────────────────────────────────────
// Sends a real push to the calling user so they can verify FCM is wired up
const sendTest = async (req, res) => {
  try {
    const { type = 'general' } = req.body;

    let title = '🔔 VTRX Test Notification';
    let body  = 'Push notifications are working! You\'re all set.';

    if (type === 'workout_reminder') {
      title = '💪 Time to train'; body = 'Test: your workout window is open.';
    } else if (type === 'streak_alert') {
      title = '🔥 Streak alert'; body = 'Test: keep your streak alive today!';
    } else if (type === 'weekly_recap') {
      title = '📊 Weekly recap'; body = 'Test: your week in review is ready.';
    } else if (type === 'comeback') {
      title = '🏃 Comeback session ready'; body = 'Test: your 15-min Welcome Back session awaits.';
    } else if (type === 'milestone') {
      title = '🎉 Milestone unlocked!'; body = 'Test: you hit a new milestone.';
    }

    const result = await notifService.sendToUser({
      userId: req.user.id,
      title,
      body,
      data: { type, isTest: 'true' },
    });
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Send test notification error:', err);
    res.status(500).json({ success: false, message: 'Failed to send test notification' });
  }
};

module.exports = {
  registerToken, removeToken,
  getNotifications, markAllRead, markOneRead, deleteNotification,
  getPreferences, updatePreferences,
  sendTest,
};
