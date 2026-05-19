// ─────────────────────────────────────────────────────────────────────────────
// controllers/aiController.js — AI Coaching Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const aiService    = require('../services/aiService');
const notifService = require('../services/notificationService');
const prisma       = require('../config/database');
const logger       = require('../utils/logger');

// ── POST /api/ai/mood-recommendation ─────────────────────────────────────────
const getMoodRecommendation = async (req, res) => {
  const { mood, notes } = req.body;

  if (!mood) {
    return res.status(400).json({ success: false, message: 'Mood is required' });
  }

  try {
    // Log the mood
    await prisma.moodLog.create({
      data: { userId: req.user.id, mood, notes },
    });

    // Get recent workout names for context
    const recentLogs = await prisma.workoutLog.findMany({
      where:   { userId: req.user.id },
      orderBy: { completedAt: 'desc' },
      take:    5,
      select:  { name: true },
    });

    // Get user data for personalised response
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { goal: true, daysPerWeek: true, streakDays: true },
    });

    const { recommendation, tokensUsed } = await aiService.generateMoodRecommendation({
      mood,
      userGoal:       user?.goal,
      recentWorkouts: recentLogs.map(l => l.name),
      daysPerWeek:    user?.daysPerWeek,
      streakDays:     user?.streakDays,
    });

    res.json({
      success: true,
      data:    { recommendation, mood, tokensUsed },
    });
  } catch (err) {
    logger.error('getMoodRecommendation error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate recommendation' });
  }
};

// ── GET /api/ai/weekly-insight ─────────────────────────────────────────────
const getWeeklyInsight = async (req, res) => {
  try {
    const weekAgo     = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [thisWeek, lastWeek, user] = await Promise.all([
      prisma.workoutLog.findMany({
        where: { userId: req.user.id, completedAt: { gte: weekAgo } },
        select: { duration: true, caloriesBurned: true },
      }),
      prisma.workoutLog.findMany({
        where: { userId: req.user.id, completedAt: { gte: twoWeeksAgo, lt: weekAgo } },
        select: { duration: true, caloriesBurned: true },
      }),
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: { goal: true, streakDays: true },
      }),
    ]);

    const weeklyStats = {
      workouts:      thisWeek.length,
      totalMinutes:  thisWeek.reduce((s, l) => s + l.duration, 0),
      totalCalories: thisWeek.reduce((s, l) => s + (l.caloriesBurned || 0), 0),
    };

    const previousWeek = {
      workouts:      lastWeek.length,
      totalMinutes:  lastWeek.reduce((s, l) => s + l.duration, 0),
      totalCalories: lastWeek.reduce((s, l) => s + (l.caloriesBurned || 0), 0),
    };

    const { insight, tokensUsed } = await aiService.generateWeeklyInsight({
      weeklyStats,
      previousWeek,
      userGoal:   user?.goal,
      streakDays: user?.streakDays,
    });

    res.json({
      success: true,
      data:    { insight, weeklyStats, previousWeek, tokensUsed },
    });
  } catch (err) {
    logger.error('getWeeklyInsight error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate insight' });
  }
};

// ── POST /api/ai/nutrition-advice ─────────────────────────────────────────────
const getNutritionAdvice = async (req, res) => {
  const { mood } = req.body;

  try {
    const [user, todayLog] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: { goal: true },
      }),
      prisma.workoutLog.findFirst({
        where: {
          userId:      req.user.id,
          completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
        select: { name: true, caloriesBurned: true },
      }),
    ]);

    const { advice, tokensUsed } = await aiService.generateNutritionAdvice({
      mood,
      userGoal:       user?.goal,
      todayWorkout:   todayLog?.name,
      caloriesBurned: todayLog?.caloriesBurned,
    });

    res.json({ success: true, data: { advice, tokensUsed } });
  } catch (err) {
    logger.error('getNutritionAdvice error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate nutrition advice' });
  }
};

// ── POST /api/ai/workout-plan ─────────────────────────────────────────────────
// Premium only — generates a personalised programme
const generatePlan = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { goal: true, fitnessLevel: true, daysPerWeek: true, equipment: true, location: true },
    });

    const { plan, tokensUsed } = await aiService.generateWorkoutPlan({
      goal:         user?.goal,
      fitnessLevel: user?.fitnessLevel,
      daysPerWeek:  user?.daysPerWeek,
      equipment:    user?.equipment,
      location:     user?.location,
    });

    res.json({ success: true, data: { plan, tokensUsed } });
  } catch (err) {
    logger.error('generatePlan error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate plan' });
  }
};

// ── POST /api/ai/recovery ─────────────────────────────────────────────────────
const getRecoveryAdvice = async (req, res) => {
  const { mood, sleepHours } = req.body;

  try {
    const [recentLogs, user] = await Promise.all([
      prisma.workoutLog.findMany({
        where:   { userId: req.user.id },
        orderBy: { completedAt: 'desc' },
        take:    5,
        select:  { name: true },
      }),
      prisma.user.findUnique({
        where:  { id: req.user.id },
        select: { streakDays: true },
      }),
    ]);

    const { advice, tokensUsed } = await aiService.generateRecoveryAdvice({
      recentWorkouts: recentLogs.map(l => l.name),
      streakDays:     user?.streakDays,
      mood,
      sleepHours,
    });

    res.json({ success: true, data: { advice, tokensUsed } });
  } catch (err) {
    logger.error('getRecoveryAdvice error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate recovery advice' });
  }
};

module.exports = {
  getMoodRecommendation,
  getWeeklyInsight,
  getNutritionAdvice,
  generatePlan,
  getRecoveryAdvice,
};
