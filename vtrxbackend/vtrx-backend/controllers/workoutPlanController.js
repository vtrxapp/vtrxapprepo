// ─────────────────────────────────────────────────────────────────────────────
// controllers/workoutPlanController.js — AI Workout Plan Management
// ─────────────────────────────────────────────────────────────────────────────

const prisma   = require('../config/database');
const logger   = require('../utils/logger');
const planSvc  = require('../services/workoutPlanService');

// ── POST /api/workouts/generate-plan ─────────────────────────────────────────
// Generates a new 4-week AI plan and saves it. Deactivates any existing plan.
const generatePlan = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: {
        id: true, name: true, email: true,
        goal: true, fitnessLevel: true, daysPerWeek: true,
        equipment: true, location: true,
        sessionDuration: true, preferredStyles: true,
        gender: true, age: true, weight: true, height: true,
      },
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Generate plan via Anthropic Claude
    const plan = await planSvc.generateWorkoutPlan(user);

    // Deactivate existing active plans
    await prisma.workoutPlan.updateMany({
      where: { userId: req.user.id, isActive: true },
      data:  { isActive: false },
    });

    // Persist the new plan
    const saved = await prisma.workoutPlan.create({
      data: {
        userId:     req.user.id,
        planJson:   plan,
        weekNumber: 1,
        isActive:   true,
      },
    });

    res.json({
      success: true,
      data:    { plan, planId: saved.id, weekNumber: 1 },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/workouts/active-plan ────────────────────────────────────────────
// Returns the user's current active plan (null if none generated yet).
const getActivePlan = async (req, res, next) => {
  try {
    const record = await prisma.workoutPlan.findFirst({
      where:   { userId: req.user.id, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) return res.json({ success: true, data: { plan: null } });

    res.json({
      success: true,
      data: {
        plan:       record.planJson,
        planId:     record.id,
        weekNumber: record.weekNumber,
        createdAt:  record.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/workouts/active-plan/advance-week ─────────────────────────────
// Advances the active plan to the next week (1 → 2 → 3 → 4).
const advancePlanWeek = async (req, res, next) => {
  try {
    const record = await prisma.workoutPlan.findFirst({
      where: { userId: req.user.id, isActive: true },
    });
    if (!record) return res.status(404).json({ success: false, message: 'No active plan' });

    const newWeek = Math.min((record.weekNumber || 1) + 1, 4);
    await prisma.workoutPlan.update({
      where: { id: record.id },
      data:  { weekNumber: newWeek },
    });

    res.json({ success: true, data: { weekNumber: newWeek } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/workouts/exercise-log ──────────────────────────────────────────
// Logs weight/reps for a single exercise (progressive overload tracking).
const logExercise = async (req, res, next) => {
  try {
    const {
      planId, exerciseName, setsCompleted,
      repsCompleted, weightUsedLbs, durationSecs, sessionDate,
    } = req.body;

    if (!exerciseName) return res.status(400).json({ success: false, message: 'exerciseName required' });

    const log = await prisma.exerciseLog.create({
      data: {
        userId:        req.user.id,
        planId:        planId || null,
        exerciseName,
        setsCompleted: parseInt(setsCompleted) || 1,
        repsCompleted: String(repsCompleted || '0'),
        weightUsedLbs: weightUsedLbs != null ? parseFloat(weightUsedLbs) : null,
        durationSecs:  durationSecs  != null ? parseInt(durationSecs)   : null,
        sessionDate:   sessionDate   ? new Date(sessionDate) : new Date(),
      },
    });

    res.json({ success: true, data: { log } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/workouts/exercise-history/:exerciseName ─────────────────────────
// Returns the last 8 logs for a given exercise — used for overload hints.
const getExerciseHistory = async (req, res, next) => {
  try {
    const { exerciseName } = req.params;
    const logs = await prisma.exerciseLog.findMany({
      where:   { userId: req.user.id, exerciseName: { contains: exerciseName, mode: 'insensitive' } },
      orderBy: { sessionDate: 'desc' },
      take:    8,
    });

    res.json({ success: true, data: { logs } });
  } catch (err) {
    next(err);
  }
};

module.exports = { generatePlan, getActivePlan, advancePlanWeek, logExercise, getExerciseHistory };
