// ─────────────────────────────────────────────────────────────────────────────
// controllers/userController.js — User Profile Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma  = require('../config/database');
const logger  = require('../utils/logger');
const { validatePlan }    = require('../data/planGenerator');
const { generateAIPlan }  = require('../services/aiPlanGenerator');
const { canGeneratePlan } = require('../utils/planAccess');
const { toDateOnly }      = require('../services/streakFreezeService');

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
    sessionDuration, preferredStyles,
    wantsMealSuggestions, nutritionGoal, trackingPreference,
    dietaryRestrictions, mealsPerDay, bodyFatPercentage, goalWeightLbs,
  } = req.body;

  try {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(name                 !== undefined && { name }),
        ...(username             !== undefined && { username: username.toLowerCase() }),
        ...(gender               !== undefined && { gender }),
        ...(age !== undefined && age !== null && !isNaN(parseInt(age))         && { age: parseInt(age) }),
        ...(weight !== undefined && weight !== null && !isNaN(parseFloat(weight)) && { weight: parseFloat(weight) }),
        ...(height               !== undefined && { height }),
        ...(goal                 !== undefined && { goal }),
        ...(fitnessLevel         !== undefined && { fitnessLevel }),
        ...(daysPerWeek          !== undefined && { daysPerWeek: parseInt(daysPerWeek) }),
        ...(equipment            !== undefined && { equipment }),
        ...(location             !== undefined && { location }),
        ...(sessionDuration      !== undefined && { sessionDuration }),
        ...(preferredStyles      !== undefined && { preferredStyles }),
        ...(wantsMealSuggestions !== undefined && { wantsMealSuggestions: Boolean(wantsMealSuggestions) }),
        ...(nutritionGoal        !== undefined && { nutritionGoal }),
        ...(trackingPreference   !== undefined && { trackingPreference }),
        ...(dietaryRestrictions  !== undefined && { dietaryRestrictions: Array.isArray(dietaryRestrictions) ? dietaryRestrictions : [] }),
        ...(mealsPerDay          !== undefined && { mealsPerDay }),
        ...(bodyFatPercentage    !== undefined && { bodyFatPercentage: parseFloat(bodyFatPercentage) || null }),
        ...(goalWeightLbs        !== undefined && { goalWeightLbs: parseFloat(goalWeightLbs) || null }),
      },
    });

    // Auto-regenerate plan when any plan-affecting field changes and the user
    // has all three required fields (goal + fitnessLevel + daysPerWeek).
    // Fire-and-forget: the AI call takes a few seconds and this update may be
    // an incidental side effect of an unrelated save (e.g. changing location
    // in Settings) — don't make the caller wait on it.
    // Free tier: skip silently once an active plan already exists — a Settings
    // edit shouldn't spend a free user's one-time plan on their behalf.
    const planFieldUpdated = [goal, fitnessLevel, daysPerWeek, equipment].some(f => f !== undefined);
    if (planFieldUpdated && updated.goal && updated.fitnessLevel && updated.daysPerWeek) {
      canGeneratePlan(prisma.workoutPlan, req.user.id, updated.isPremium)
        .then(async (allowed) => {
          if (!allowed) return;
          const plan = await generateAIPlan(updated);
          const { valid, errors } = validatePlan(plan);
          if (!valid) {
            logger.warn(`[auto-plan] Validation failed for user ${req.user.id}:`, errors);
            return;
          }
          await prisma.workoutPlan.updateMany({ where: { userId: req.user.id, isActive: true }, data: { isActive: false } });
          await prisma.workoutPlan.create({ data: { userId: req.user.id, planJson: plan, weekNumber: 1, isActive: true } });
          logger.info(`[auto-plan] Generated "${plan.planName}" for user ${req.user.id}`);
        })
        .catch(planErr => logger.error('[auto-plan] Error generating plan:', planErr));
    }

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

// ── GET /api/users/water — Today's water intake ────────────────────────────────
const getTodayWater = async (req, res) => {
  try {
    const today = toDateOnly(new Date());
    const log = await prisma.waterLog.findUnique({
      where:  { userId_loggedAt: { userId: req.user.id, loggedAt: today } },
      select: { glasses: true },
    });
    res.json({ success: true, data: { glasses: log?.glasses || 0 } });
  } catch (err) {
    logger.error('getTodayWater error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch water intake' });
  }
};

// ── POST /api/users/water — Log water intake ──────────────────────────────────
const logWater = async (req, res) => {
  const { glasses } = req.body;
  // Number(glasses) alone would accept "", " ", false, null, and "0x10" as
  // valid counts (all coerce to a finite number) — only allow an actual
  // number or a plain digit string.
  const numericGlasses =
    typeof glasses === 'number' ? glasses :
    typeof glasses === 'string' && /^\d+$/.test(glasses.trim()) ? Number(glasses.trim()) :
    NaN;
  if (!Number.isInteger(numericGlasses) || numericGlasses < 0 || numericGlasses > 50) {
    return res.status(400).json({ success: false, message: 'glasses must be an integer between 0 and 50' });
  }
  try {
    const today = toDateOnly(new Date());
    const log = await prisma.waterLog.upsert({
      where:  { userId_loggedAt: { userId: req.user.id, loggedAt: today } },
      create: { userId: req.user.id, glasses: numericGlasses, loggedAt: today },
      update: { glasses: numericGlasses },
    });
    res.json({ success: true, data: { glasses: log.glasses } });
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
  getPersonalRecords,
  getTodayWater,
  logWater,
};
