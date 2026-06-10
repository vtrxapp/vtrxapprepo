// ─────────────────────────────────────────────────────────────────────────────
// controllers/userController.js — User Profile Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma  = require('../config/database');
const logger  = require('../utils/logger');

// ── GET /api/users/profile ────────────────────────────────────────────────────
const getProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        subscription: true,
        _count: {
          select: {
            workoutLogs:   true,
            savedWorkouts: true,
            savedMeals:    true,
          },
        },
      },
    });

    res.json({ success: true, data: { user } });
  } catch (error) {
    logger.error('getProfile error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
};

// ── PUT /api/users/profile — Update profile ───────────────────────────────────
const updateProfile = async (req, res) => {
  const {
    name, username, gender, age, weight, height,
    goal, fitnessLevel, daysPerWeek, equipment, location,
  } = req.body;

  try {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(name         !== undefined && { name }),
        ...(username     !== undefined && { username: username.toLowerCase() }),
        ...(gender       !== undefined && { gender }),
        ...(age          !== undefined && { age: parseInt(age) }),
        ...(weight       !== undefined && { weight: parseFloat(weight) }),
        ...(height       !== undefined && { height }),
        ...(goal         !== undefined && { goal }),
        ...(fitnessLevel !== undefined && { fitnessLevel }),
        ...(daysPerWeek  !== undefined && { daysPerWeek: parseInt(daysPerWeek) }),
        ...(equipment    !== undefined && { equipment }),
        ...(location     !== undefined && { location }),
      },
    });

    res.json({ success: true, data: { user: updated } });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'Username already taken' });
    }
    logger.error('updateProfile error:', error);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
};

// ── POST /api/users/mood — Log today's mood ───────────────────────────────────
const logMood = async (req, res) => {
  const { mood, notes } = req.body;

  const validMoods = ['empty', 'low', 'okay', 'good', 'peak'];
  if (!validMoods.includes(mood)) {
    return res.status(400).json({ success: false, message: 'Invalid mood value' });
  }

  try {
    const moodLog = await prisma.moodLog.create({
      data: { userId: req.user.id, mood, notes },
    });

    res.status(201).json({ success: true, data: { moodLog } });
  } catch (error) {
    logger.error('logMood error:', error);
    res.status(500).json({ success: false, message: 'Failed to log mood' });
  }
};

// ── GET /api/users/progress — Progress history ────────────────────────────────
const getProgressLogs = async (req, res) => {
  const { limit = 12 } = req.query;

  try {
    const logs = await prisma.progressLog.findMany({
      where:   { userId: req.user.id },
      orderBy: { loggedAt: 'desc' },
      take:    parseInt(limit),
    });

    res.json({ success: true, data: { logs } });
  } catch (error) {
    logger.error('getProgressLogs error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch progress' });
  }
};

// ── POST /api/users/progress — Log progress measurement ──────────────────────
const logProgress = async (req, res) => {
  const { weight, bodyFat, waist, chest, arms, notes } = req.body;

  if (weight  && (parseFloat(weight)  < 50  || parseFloat(weight)  > 700))  return res.status(400).json({ success: false, message: 'Weight must be between 50 and 700 lbs' });
  if (bodyFat && (parseFloat(bodyFat) < 2   || parseFloat(bodyFat) > 70))   return res.status(400).json({ success: false, message: 'Body fat must be between 2% and 70%' });
  if (waist   && (parseFloat(waist)   < 20  || parseFloat(waist)   > 100))  return res.status(400).json({ success: false, message: 'Waist must be between 20 and 100 inches' });
  if (notes   && notes.length > 500) return res.status(400).json({ success: false, message: 'Notes must be under 500 characters' });

  try {
    const log = await prisma.progressLog.create({
      data: {
        userId:  req.user.id,
        weight:  weight  ? parseFloat(weight)  : null,
        bodyFat: bodyFat ? parseFloat(bodyFat) : null,
        waist:   waist   ? parseFloat(waist)   : null,
        chest:   chest   ? parseFloat(chest)   : null,
        arms:    arms    ? parseFloat(arms)    : null,
        notes,
      },
    });

    res.status(201).json({ success: true, data: { log } });
  } catch (error) {
    logger.error('logProgress error:', error);
    res.status(500).json({ success: false, message: 'Failed to log progress' });
  }
};

// ── GET /api/users/notifications ─────────────────────────────────────────────
const getNotifications = async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take:    20,
    });

    const unreadCount = notifications.filter(n => !n.read).length;

    res.json({ success: true, data: { notifications, unreadCount } });
  } catch (error) {
    logger.error('getNotifications error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
};

// ── PATCH /api/users/notifications/read — Mark all as read ───────────────────
const markNotificationsRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data:  { read: true },
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('markNotificationsRead error:', error);
    res.status(500).json({ success: false, message: 'Failed to update notifications' });
  }
};

// ── GET /api/users/personal-records ──────────────────────────────────────────
const getPersonalRecords = async (req, res) => {
  try {
    const records = await prisma.personalRecord.findMany({
      where:   { userId: req.user.id },
      orderBy: { achievedAt: 'desc' },
    });

    // Keep only the best record per exercise name
    const best = {};
    for (const r of records) {
      if (!best[r.exerciseName] || (r.weight || 0) > (best[r.exerciseName].weight || 0)) {
        best[r.exerciseName] = r;
      }
    }

    res.json({ success: true, data: { records: Object.values(best) } });
  } catch (error) {
    logger.error('getPersonalRecords error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch personal records' });
  }
};

// ── POST /api/users/water — Log water intake ──────────────────────────────────
const logWater = async (req, res) => {
  const { glasses } = req.body;
  if (glasses === undefined || glasses === null || !Number.isInteger(Number(glasses)) || Number(glasses) < 0 || Number(glasses) > 50) {
    return res.status(400).json({ success: false, message: 'glasses must be an integer between 0 and 50' });
  }
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    await prisma.waterLog.upsert({
      where:  { userId_loggedAt: { userId: req.user.id, loggedAt: today } },
      create: { userId: req.user.id, glasses: Number(glasses), loggedAt: today },
      update: { glasses: Number(glasses) },
    }).catch(async () => {
      await prisma.waterLog.create({ data: { userId: req.user.id, glasses: Number(glasses) } });
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('logWater error:', err);
    res.status(500).json({ success: false, message: 'Failed to log water' });
  }
};

module.exports = {
  getProfile,
  updateProfile,
  logMood,
  getProgressLogs,
  logProgress,
  getNotifications,
  markNotificationsRead,
  getPersonalRecords,
  logWater,
};
