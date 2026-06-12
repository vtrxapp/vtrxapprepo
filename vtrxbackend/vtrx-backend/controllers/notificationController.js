// ─────────────────────────────────────────────────────────────────────────────
// controllers/notificationController.js
// ─────────────────────────────────────────────────────────────────────────────

const notifService = require('../services/notificationService');
const prisma       = require('../config/database');
const logger       = require('../utils/logger');

// ── POST /api/notifications/register ─────────────────────────────────────────
// Register a device FCM token (called on app open or permission grant)
const registerToken = async (req, res) => {
  const { token, platform } = req.body;

  if (!token || !platform) {
    return res.status(400).json({ success: false, message: 'Token and platform required' });
  }

  if (!['ios', 'android', 'web'].includes(platform)) {
    return res.status(400).json({ success: false, message: 'Platform must be ios, android, or web' });
  }

  try {
    await notifService.registerToken({ userId: req.user.id, token, platform });
    res.json({ success: true, message: 'Device registered for notifications' });
  } catch (err) {
    logger.error('Register token error:', err);
    res.status(500).json({ success: false, message: 'Failed to register device' });
  }
};

// ── DELETE /api/notifications/register ────────────────────────────────────────
// Remove device token (on logout or notification permission revoked)
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
      take:    30,
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

// ── POST /api/notifications/test ─────────────────────────────────────────────
// Test endpoint — send yourself a push notification
const sendTest = async (req, res) => {
  try {
    const result = await notifService.sendToUser({
      userId: req.user.id,
      title:  '🔔 VTRX Test Notification',
      body:   'Push notifications are working! You\'re all set.',
      data:   { type: 'test' },
    });
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Send test notification error:', err);
    res.status(500).json({ success: false, message: 'Failed to send test notification' });
  }
};

module.exports = { registerToken, removeToken, getNotifications, markAllRead, markOneRead, deleteNotification, sendTest };
