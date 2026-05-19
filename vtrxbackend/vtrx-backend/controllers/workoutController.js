// ─────────────────────────────────────────────────────────────────────────────
// controllers/workoutController.js — Workout & Logging Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma    = require('../config/database');
const aiService = require('../services/aiService');
const ymove     = require('../services/ymoveService');
const logger    = require('../utils/logger');

// ── GET /api/workouts — Get available workout programmes ──────────────────────
const getWorkouts = async (req, res) => {
  const { type, difficulty, source = 'all' } = req.query;

  try {
    // Get workouts from our database
    const dbWorkouts = await prisma.workout.findMany({
      where: {
        isPublic: true,
        ...(type       && { type }),
        ...(difficulty && { difficulty }),
      },
      include: {
        exercises: {
          include: { exercise: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Optionally enrich with Ymove content
    let ymoveWorkouts = [];
    if (source === 'ymove' || source === 'all') {
      ymoveWorkouts = (await ymove.getWorkouts({ type, difficulty })).workouts || [];
    }

    res.json({
      success: true,
      data: {
        workouts: [...dbWorkouts, ...ymoveWorkouts],
        total:    dbWorkouts.length + ymoveWorkouts.length,
      },
    });
  } catch (error) {
    logger.error('getWorkouts error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch workouts' });
  }
};

// ── GET /api/workouts/:id — Get single workout ────────────────────────────────
const getWorkoutById = async (req, res) => {
  const { id } = req.params;

  try {
    const workout = await prisma.workout.findUnique({
      where: { id },
      include: {
        exercises: {
          include: { exercise: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!workout) {
      return res.status(404).json({ success: false, message: 'Workout not found' });
    }

    // If workout has a Ymove ID, try to get video URLs
    if (workout.ymoveId) {
      const ymoveData = await ymove.getWorkoutById(workout.ymoveId);
      if (ymoveData) {
        workout.ymoveData = ymoveData;
      }
    }

    res.json({ success: true, data: { workout } });
  } catch (error) {
    logger.error('getWorkoutById error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch workout' });
  }
};

// ── POST /api/workouts/log — Log a completed workout ─────────────────────────
// This is called when the user taps "Complete Workout"
const logWorkout = async (req, res) => {
  const {
    workoutId,
    name,
    type,
    duration,
    caloriesBurned,
    volume,
    notes,
    exercises,       // [{ exerciseId, sets: [{ setNumber, reps, weight }] }]
    generateAI,      // boolean — should we generate AI summary?
    energyLevel,     // user's mood today
  } = req.body;

  try {
    // 1. Create the workout log
    const workoutLog = await prisma.workoutLog.create({
      data: {
        userId:        req.user.id,
        workoutId:     workoutId || null,
        name,
        type,
        duration:      parseInt(duration),
        caloriesBurned: caloriesBurned ? parseInt(caloriesBurned) : null,
        volume:        volume ? parseFloat(volume) : null,
        notes,
        // Create exercise sets in the same transaction
        sets: {
          create: exercises?.flatMap(ex =>
            (ex.sets || []).map(set => ({
              exerciseId: ex.exerciseId,
              setNumber:  set.setNumber,
              reps:       set.reps    ? parseInt(set.reps)    : null,
              weight:     set.weight  ? parseFloat(set.weight) : null,
              duration:   set.duration ? parseInt(set.duration) : null,
              completed:  set.completed !== false,
            }))
          ) || [],
        },
      },
      include: { sets: true },
    });

    // 2. Update user streak
    await updateStreak(req.user.id);

    // 3. Generate AI summary asynchronously (don't wait for it to respond)
    if (generateAI !== false) {
      generateAndSaveAISummary({
        workoutLogId:  workoutLog.id,
        workoutName:   name,
        workoutType:   type,
        duration,
        caloriesBurned,
        exercises,
        energyLevel,
        userGoal:      req.user.goal,
        streakDays:    req.user.streakDays,
      }).catch(err => logger.error('AI summary generation failed:', err));
    }

    logger.info(`Workout logged: ${name} by user ${req.user.id}`);

    res.status(201).json({
      success: true,
      message: 'Workout logged successfully!',
      data:    { workoutLog },
    });

  } catch (error) {
    logger.error('logWorkout error:', error);
    res.status(500).json({ success: false, message: 'Failed to log workout' });
  }
};

// ── GET /api/workouts/history — User's workout history ───────────────────────
const getWorkoutHistory = async (req, res) => {
  const { limit = 20, offset = 0, type } = req.query;

  try {
    const [logs, total] = await Promise.all([
      prisma.workoutLog.findMany({
        where: {
          userId: req.user.id,
          ...(type && { type }),
        },
        include: {
          aiSummary: { select: { summary: true } },
          _count:    { select: { sets: true } },
        },
        orderBy: { completedAt: 'desc' },
        take:    parseInt(limit),
        skip:    parseInt(offset),
      }),
      prisma.workoutLog.count({ where: { userId: req.user.id } }),
    ]);

    res.json({
      success: true,
      data:    { logs, total, hasMore: parseInt(offset) + parseInt(limit) < total },
    });
  } catch (error) {
    logger.error('getWorkoutHistory error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
};

// ── GET /api/workouts/ai-summary/:logId — Get AI summary for a workout ────────
const getAISummary = async (req, res) => {
  const { logId } = req.params;

  try {
    const summary = await prisma.aISummary.findUnique({
      where: { workoutLogId: logId },
    });

    // If summary isn't ready yet, return a 202 (accepted, processing)
    if (!summary) {
      return res.status(202).json({
        success: false,
        message: 'AI summary is being generated. Try again in a moment.',
        code:    'SUMMARY_PENDING',
      });
    }

    res.json({ success: true, data: { summary } });
  } catch (error) {
    logger.error('getAISummary error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch AI summary' });
  }
};

// ── HELPER: Update user's streak ─────────────────────────────────────────────
const updateStreak = async (userId) => {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { lastActiveAt: true, streakDays: true },
  });

  const now       = new Date();
  const lastActive = user.lastActiveAt;
  let newStreak   = user.streakDays || 0;

  if (lastActive) {
    const hoursSinceLastActive = (now - lastActive) / (1000 * 60 * 60);

    if (hoursSinceLastActive < 48) {
      // Within 48 hours — extend streak
      const daysSinceLastActive = Math.floor(hoursSinceLastActive / 24);
      if (daysSinceLastActive >= 1) newStreak += 1;
    } else {
      // More than 48 hours — streak broken
      newStreak = 1;
    }
  } else {
    newStreak = 1;
  }

  await prisma.user.update({
    where: { id: userId },
    data:  { streakDays: newStreak, lastActiveAt: now },
  });
};

// ── HELPER: Generate and save AI summary ─────────────────────────────────────
const generateAndSaveAISummary = async ({
  workoutLogId,
  workoutName,
  workoutType,
  duration,
  caloriesBurned,
  exercises,
  energyLevel,
  userGoal,
  streakDays,
}) => {
  const { summary, tokensUsed, model } = await aiService.generateWorkoutSummary({
    workoutName,
    workoutType,
    duration,
    caloriesBurned,
    exercises,
    energyLevel,
    userGoal,
    streakDays,
  });

  await prisma.aISummary.create({
    data: {
      workoutLogId,
      summary,
      keyInsights:     [],
      recommendations: [],
      energyKey:       energyLevel,
      model,
      tokensUsed,
    },
  });
};

// ── GET /api/workouts/stats — Weekly stats ────────────────────────────────────
const getWeeklyStats = async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const logs = await prisma.workoutLog.findMany({
      where: {
        userId:      req.user.id,
        completedAt: { gte: weekAgo },
      },
      select: {
        duration:       true,
        caloriesBurned: true,
        type:           true,
        completedAt:    true,
      },
    });

    const stats = {
      workoutsCompleted: logs.length,
      totalMinutes:      logs.reduce((s, l) => s + l.duration,       0),
      totalCalories:     logs.reduce((s, l) => s + (l.caloriesBurned || 0), 0),
      byType: logs.reduce((acc, l) => {
        acc[l.type] = (acc[l.type] || 0) + 1;
        return acc;
      }, {}),
    };

    res.json({ success: true, data: { stats } });
  } catch (error) {
    logger.error('getWeeklyStats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

module.exports = {
  getWorkouts,
  getWorkoutById,
  logWorkout,
  getWorkoutHistory,
  getAISummary,
  getWeeklyStats,
};
