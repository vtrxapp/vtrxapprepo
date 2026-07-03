// ─────────────────────────────────────────────────────────────────────────────
// controllers/workoutPlanController.js — AI Workout Plan Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma                     = require('../config/database');
const logger                     = require('../utils/logger');
const { generateAIPlan }         = require('../services/aiPlanGenerator');
const { validatePlan }           = require('../data/planGenerator');

// ── POST /api/workouts/generate-plan ─────────────────────────────────────────
const generatePlan = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: {
        id: true, name: true, gender: true, weight: true,
        goal: true, fitnessLevel: true, daysPerWeek: true,
        equipment: true, location: true, sessionDuration: true,
      },
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const plan = await generateAIPlan(user);

    const { valid, errors, totalExercises } = validatePlan(plan);
    if (!valid) {
      logger.error('[generatePlan] Validation failed:', errors);
      return res.status(500).json({ success: false, message: 'Plan generation failed', errors });
    }

    logger.info(`[generatePlan] Generated plan "${plan.planName}" with ${totalExercises} exercises`);

    await prisma.workoutPlan.updateMany({
      where: { userId: req.user.id, isActive: true },
      data:  { isActive: false },
    });

    const saved = await prisma.workoutPlan.create({
      data: { userId: req.user.id, planJson: plan, weekNumber: 1, isActive: true },
    });

    res.json({ success: true, data: { plan, planId: saved.id, weekNumber: 1, totalExercises } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/workouts/regenerate-plan ───────────────────────────────────────
const regeneratePlan = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: {
        id: true, name: true, gender: true, weight: true,
        goal: true, fitnessLevel: true, daysPerWeek: true,
        equipment: true, location: true, sessionDuration: true,
      },
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const plan = await generateAIPlan(user);

    const { valid, errors, totalExercises } = validatePlan(plan);
    if (!valid) {
      logger.error('[regeneratePlan] Validation failed:', errors);
      return res.status(500).json({ success: false, message: 'Plan generation failed', errors });
    }

    logger.info(`[regeneratePlan] Regenerated plan "${plan.planName}" with ${totalExercises} exercises`);

    await prisma.workoutPlan.updateMany({
      where: { userId: req.user.id, isActive: true },
      data:  { isActive: false },
    });

    const saved = await prisma.workoutPlan.create({
      data: { userId: req.user.id, planJson: plan, weekNumber: 1, isActive: true },
    });

    res.json({ success: true, data: { plan, planId: saved.id, weekNumber: 1, totalExercises } });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/workouts/active-plan  (alias: /current-plan) ───────────────────
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
const advancePlanWeek = async (req, res, next) => {
  try {
    const record = await prisma.workoutPlan.findFirst({
      where: { userId: req.user.id, isActive: true },
    });
    if (!record) return res.status(404).json({ success: false, message: 'No active plan' });

    const newWeek = Math.min((record.weekNumber || 1) + 1, 4);
    await prisma.workoutPlan.update({ where: { id: record.id }, data: { weekNumber: newWeek } });

    res.json({ success: true, data: { weekNumber: newWeek } });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/workouts/exercise-log ──────────────────────────────────────────
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

module.exports = { generatePlan, regeneratePlan, getActivePlan, advancePlanWeek, logExercise, getExerciseHistory };
