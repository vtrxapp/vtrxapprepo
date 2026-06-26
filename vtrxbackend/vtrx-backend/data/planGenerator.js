// ─────────────────────────────────────────────────────────────────────────────
// data/planGenerator.js — VTRX MVP Workout Plan Generator
//
// Deterministic: same user profile always produces the same plan.
// 3 splits: Full Body (≤3 days), Upper/Lower (4 days), Push/Pull/Legs (5 days).
// No AI, no randomness, no external calls.
// ─────────────────────────────────────────────────────────────────────────────

const lib = require('./exerciseLibrary');

// ── Equipment tier ────────────────────────────────────────────────────────────
// Maps user equipment array/string → 'gym' | 'dumbbells' | 'none'
function resolveEquipmentTier(equipment) {
  const items  = Array.isArray(equipment) ? equipment : [equipment || ''];
  const joined = items.join(' ').toLowerCase();
  if (/gym|cable|machine|barbell/i.test(joined)) return 'gym';
  if (/dumbbell/i.test(joined))                  return 'dumbbells';
  return 'none';
}

// ── 4-week progressive overload ────────────────────────────────────────────────
// Week 1-2: base sets; Week 3: +1 overload; Week 4: -1 deload
function getSetsForWeek(level, weekNum) {
  const base = (level === 'advanced' || level === 'professional') ? 5
             : level === 'intermediate' ? 4
             : 3;
  if (weekNum === 3) return base + 1;
  if (weekNum === 4) return Math.max(2, base - 1);
  return base;
}

// ── Goal-based rest periods ───────────────────────────────────────────────────
function getRestSeconds(goal) {
  if (goal === 'lose_weight' || goal === 'fat_loss') return 45;
  if (goal === 'build_muscle') return 90;
  return 60;
}

// ── Goal normalisation ────────────────────────────────────────────────────────
function normaliseGoal(raw) {
  const g = (raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (g === 'build_muscle') return 'build_muscle';
  if (g === 'lose_weight' || g === 'fat_loss') return 'lose_weight';
  return 'general';
}

// ── Level normalisation ───────────────────────────────────────────────────────
function normaliseLevel(raw) {
  const l = (raw || '').toLowerCase();
  if (l === 'advanced' || l === 'professional') return 'advanced';
  if (l === 'intermediate') return 'intermediate';
  return 'beginner';
}

// ── Pick one exercise from the movement map ───────────────────────────────────
function pickExercise(movementKey, tier, sets, goal) {
  const movement = lib[movementKey];
  if (!movement) return null;
  const ex = movement[tier] || movement.none;
  if (!ex) return null;
  return {
    name:               ex.name,
    muscleGroup:        ex.muscleGroup,
    sets,
    reps:               ex.isTimed ? null : ex.defaultReps,
    restSeconds:        getRestSeconds(goal),
    isCompound:         ex.isCompound,
    isTimed:            ex.isTimed,
    defaultDurationSecs: ex.defaultDurationSecs || null,
  };
}

// ── Session templates (ordered movement keys) ─────────────────────────────────
const SESSIONS = {
  FULL_BODY_A: {
    name:      'Full Body A',
    movements: ['SQUAT', 'BENCH', 'LAT_PULLDOWN', 'SHOULDER_PRESS', 'PLANK'],
    duration:  45,
  },
  FULL_BODY_B: {
    name:      'Full Body B',
    movements: ['RDL', 'LUNGE', 'ROW', 'BICEP_CURL', 'CRUNCHES'],
    duration:  45,
  },
  UPPER: {
    name:      'Upper Body',
    movements: ['BENCH', 'SHOULDER_PRESS', 'LAT_PULLDOWN', 'ROW', 'BICEP_CURL', 'TRICEP_PUSHDOWN'],
    duration:  50,
  },
  LOWER: {
    name:      'Lower Body',
    movements: ['SQUAT', 'RDL', 'LUNGE', 'CALF_RAISE', 'PLANK'],
    duration:  45,
  },
  PUSH: {
    name:      'Push',
    movements: ['BENCH', 'SHOULDER_PRESS', 'TRICEP_PUSHDOWN'],
    duration:  40,
  },
  PULL: {
    name:      'Pull',
    movements: ['LAT_PULLDOWN', 'ROW', 'BICEP_CURL'],
    duration:  40,
  },
  LEGS: {
    name:      'Legs',
    movements: ['SQUAT', 'RDL', 'LUNGE', 'CALF_RAISE', 'PLANK'],
    duration:  45,
  },
  REST: {
    name:      'Rest Day',
    isRest:    true,
    movements: [],
    duration:  0,
  },
};

// ── Weekly schedules — [dayName, sessionKey][] ────────────────────────────────
const SCHEDULES = {
  2: [
    ['Monday',    'FULL_BODY_A'],
    ['Tuesday',   'REST'],
    ['Wednesday', 'REST'],
    ['Thursday',  'FULL_BODY_B'],
    ['Friday',    'REST'],
    ['Saturday',  'REST'],
    ['Sunday',    'REST'],
  ],
  3: [
    ['Monday',    'FULL_BODY_A'],
    ['Tuesday',   'REST'],
    ['Wednesday', 'FULL_BODY_B'],
    ['Thursday',  'REST'],
    ['Friday',    'FULL_BODY_A'],
    ['Saturday',  'REST'],
    ['Sunday',    'REST'],
  ],
  4: [
    ['Monday',    'UPPER'],
    ['Tuesday',   'LOWER'],
    ['Wednesday', 'REST'],
    ['Thursday',  'UPPER'],
    ['Friday',    'LOWER'],
    ['Saturday',  'REST'],
    ['Sunday',    'REST'],
  ],
  5: [
    ['Monday',    'PUSH'],
    ['Tuesday',   'PULL'],
    ['Wednesday', 'LEGS'],
    ['Thursday',  'PUSH'],
    ['Friday',    'PULL'],
    ['Saturday',  'REST'],
    ['Sunday',    'REST'],
  ],
};

// ── Human-readable plan name ──────────────────────────────────────────────────
function buildPlanName(goal, level, frequency) {
  const GOAL_LABELS  = { build_muscle: 'Muscle Building', lose_weight: 'Fat Loss', general: 'General Fitness' };
  const LEVEL_LABELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
  return `${LEVEL_LABELS[level] || level} ${GOAL_LABELS[goal] || goal} — ${frequency}×/week`;
}

// ── Simple calorie estimate ───────────────────────────────────────────────────
function estimateCalories(durationMins, goal, weightLbs) {
  const met      = goal === 'lose_weight' ? 7.0 : goal === 'build_muscle' ? 5.0 : 4.5;
  const weightKg = (weightLbs || 165) * 0.453592;
  return Math.round(met * weightKg * (durationMins / 60));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN GENERATOR — returns a complete 4-week plan
// ─────────────────────────────────────────────────────────────────────────────
function generatePlan(userProfile) {
  const daysRaw  = parseInt(userProfile.daysPerWeek || userProfile.days || 3);
  const days     = daysRaw <= 2 ? 2 : daysRaw <= 3 ? 3 : daysRaw <= 4 ? 4 : 5;
  const goal     = normaliseGoal(userProfile.goal);
  const level    = normaliseLevel(userProfile.fitnessLevel || userProfile.level);
  const tier     = resolveEquipmentTier(userProfile.equipment);
  const schedule = SCHEDULES[days];

  const weeks = [];
  for (let weekNum = 1; weekNum <= 4; weekNum++) {
    const sets = getSetsForWeek(level, weekNum);
    const sessions = schedule.map(([dayOfWeek, sessionKey]) => {
      if (sessionKey === 'REST') {
        return { dayOfWeek, sessionName: 'Rest Day', isRestDay: true, durationMins: 0, exercises: [] };
      }
      const tpl = SESSIONS[sessionKey];
      const exercises = tpl.movements
        .map(key => pickExercise(key, tier, sets, goal))
        .filter(Boolean);
      return {
        dayOfWeek,
        sessionName:  tpl.name,
        isRestDay:    false,
        durationMins: tpl.duration,
        exercises,
      };
    });
    weeks.push({ weekNumber: weekNum, sessions });
  }

  return {
    planName:   buildPlanName(goal, level, days),
    frequency:  days,
    level,
    equipment:  tier,
    totalWeeks: 4,
    weeks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-SESSION GENERATOR — used by the day-switch flow
// movements: array of movement keys e.g. ['SQUAT', 'BENCH', 'LAT_PULLDOWN']
// ─────────────────────────────────────────────────────────────────────────────
function generateSession(userProfile, movements, maxEx = 5) {
  const goal  = normaliseGoal(userProfile.goal);
  const level = normaliseLevel(userProfile.fitnessLevel || userProfile.level);
  const tier  = resolveEquipmentTier(userProfile.equipment);
  const sets  = getSetsForWeek(level, 1);

  const exercises = (movements || [])
    .slice(0, maxEx)
    .map(key => pickExercise(key, tier, sets, goal))
    .filter(Boolean);

  const durationMins = 45;
  return {
    exercises,
    durationMins,
    calories: estimateCalories(durationMins, goal, userProfile.weight),
    type:     goal === 'build_muscle' ? 'STRENGTH' : goal === 'lose_weight' ? 'HIIT' : 'STRENGTH',
    sets,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN VALIDATOR — sanity check before saving to DB
// ─────────────────────────────────────────────────────────────────────────────
function validatePlan(plan) {
  const errors = [];
  let totalExercises = 0;

  for (const week of (plan.weeks || [])) {
    for (const session of (week.sessions || [])) {
      if (session.isRestDay) continue;
      const exList = session.exercises || [];
      if (exList.length === 0) {
        errors.push(`Week ${week.weekNumber} ${session.dayOfWeek}: no exercises`);
        continue;
      }
      for (const ex of exList) {
        totalExercises++;
        if (!ex.name)                                    errors.push(`Week ${week.weekNumber}: exercise missing name`);
        if (!ex.sets || ex.sets < 1)                    errors.push(`${ex.name}: sets must be >= 1`);
        if (!ex.isTimed && (!ex.reps || ex.reps < 1))  errors.push(`${ex.name}: non-timed exercise missing reps`);
        if (ex.isTimed && !ex.defaultDurationSecs)      errors.push(`${ex.name}: timed exercise missing defaultDurationSecs`);
      }
    }
  }

  if (totalExercises === 0) errors.push('Plan contains no exercises at all');
  return { valid: errors.length === 0, errors, totalExercises };
}

module.exports = {
  generatePlan,
  generateSession,
  validatePlan,
  SCHEDULES,
  SESSIONS,
  resolveEquipmentTier,
  getSetsForWeek,
  getRestSeconds,
};
