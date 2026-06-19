// ─────────────────────────────────────────────────────────────────────────────
// data/planGenerator.js — Deterministic workout plan rule engine
//
// generatePlan(userProfile, library) → complete 4-week plan JSON
//
// Every call with the same userProfile and library produces identical output.
// No randomness, no AI, no external API calls at generation time.
// Video URLs are NOT included — fetch them at display time via
// GET /workouts/exercise-video/:ymoveId (URLs expire every 48 h).
// ─────────────────────────────────────────────────────────────────────────────

const { PLAN_TEMPLATES } = require('./planTemplates');

// ─────────────────────────────────────────────────────────────────────────────
// GOAL RULES — rep/set targets and session style
// ─────────────────────────────────────────────────────────────────────────────
const GOAL_RULES = {
  build_muscle: {
    repsPerSet:        { min: 6,  max: 12 },
    setsModifier:      0,
    restSeconds:       75,
    compoundFirst:     true,
    cardioFinisher:    false,
    calorieMultiplier: 1.0,
    workoutType:       'STRENGTH',
  },
  lose_weight: {
    repsPerSet:        { min: 12, max: 20 },
    setsModifier:      -1,
    restSeconds:       40,
    compoundFirst:     false,
    cardioFinisher:    true,
    calorieMultiplier: 1.2,
    workoutType:       'HIIT',
  },
  stay_active: {
    repsPerSet:        { min: 10, max: 15 },
    setsModifier:      0,
    restSeconds:       60,
    compoundFirst:     true,
    cardioFinisher:    false,
    calorieMultiplier: 0.9,
    workoutType:       'STRENGTH',
  },
  improve_endurance: {
    repsPerSet:        { min: 15, max: 25 },
    setsModifier:      -1,
    restSeconds:       30,
    compoundFirst:     false,
    cardioFinisher:    true,
    calorieMultiplier: 1.3,
    workoutType:       'CARDIO',
  },
  get_toned: {
    repsPerSet:        { min: 12, max: 15 },
    setsModifier:      0,
    restSeconds:       45,
    compoundFirst:     true,
    cardioFinisher:    true,
    calorieMultiplier: 1.1,
    workoutType:       'STRENGTH',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL RULES — volume per session
// ─────────────────────────────────────────────────────────────────────────────
const LEVEL_RULES = {
  beginner: {
    setsPerExercise:           3,
    exercisesPerMuscleGroup:   1,
    difficultiesAllowed:       ['BEGINNER'],
    sessionDurationMins: { '15-30': 20, '30-45': 30, '45-60': 40, '60+': 50 },
  },
  intermediate: {
    setsPerExercise:           4,
    exercisesPerMuscleGroup:   1,
    difficultiesAllowed:       ['BEGINNER', 'INTERMEDIATE'],
    sessionDurationMins: { '15-30': 25, '30-45': 38, '45-60': 50, '60+': 65 },
  },
  advanced: {
    setsPerExercise:           5,
    exercisesPerMuscleGroup:   2,
    difficultiesAllowed:       ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'],
    sessionDurationMins: { '15-30': 28, '30-45': 42, '45-60': 58, '60+': 75 },
  },
  professional: {
    setsPerExercise:           5,
    exercisesPerMuscleGroup:   2,
    difficultiesAllowed:       ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'],
    sessionDurationMins: { '15-30': 30, '30-45': 45, '45-60': 60, '60+': 80 },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// EQUIPMENT RULES — maps user equipment to library tiers
// Tiers are ordered: the generator tries each tier in turn.
// ─────────────────────────────────────────────────────────────────────────────
const EQUIPMENT_RULES = {
  none:         ['bodyweight'],
  has_dumbbells:['bodyweight', 'dumbbells'],
  has_barbell:  ['bodyweight', 'dumbbells'],
  has_bench:    ['bodyweight', 'dumbbells'],
  gym_access:   ['bodyweight', 'dumbbells', 'gym'],
  // Aliases for what users may supply from the onboarding screen
  Bodyweight:   ['bodyweight'],
  Dumbbells:    ['bodyweight', 'dumbbells'],
  Barbell:      ['bodyweight', 'dumbbells'],
  Gym:          ['bodyweight', 'dumbbells', 'gym'],
};

// ─────────────────────────────────────────────────────────────────────────────
// SEX ADJUSTMENTS — reorders muscle groups within a session
// ─────────────────────────────────────────────────────────────────────────────
const SEX_MUSCLE_EMPHASIS = {
  male:   { prioritise: ['chest', 'shoulders', 'back', 'biceps'], deprioritise: [] },
  female: { prioritise: ['glutes', 'legs', 'core'],               deprioritise: [] },
  other:  { prioritise: [],                                        deprioritise: [] },
};

// ─────────────────────────────────────────────────────────────────────────────
// MET calorie formula: calories = MET × weightKg × (durationMins / 60)
// ─────────────────────────────────────────────────────────────────────────────
const MET_VALUES = {
  build_muscle:     5.0,
  lose_weight:      7.0,
  stay_active:      4.5,
  improve_endurance:8.0,
  get_toned:        6.0,
};

function calculateCalories(weightLbs, durationMins, goal, multiplier) {
  const weightKg = (weightLbs || 165) * 0.453592;
  const met      = MET_VALUES[goal] || 5.0;
  return Math.round(met * weightKg * (durationMins / 60) * (multiplier || 1.0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Exercise count caps by session duration and level
// ─────────────────────────────────────────────────────────────────────────────
const EXERCISE_CAPS = {
  '15-30': { beginner: 3, intermediate: 4, advanced: 4,  professional: 4  },
  '30-45': { beginner: 4, intermediate: 5, advanced: 5,  professional: 5  },
  '45-60': { beginner: 5, intermediate: 6, advanced: 6,  professional: 6  },
  '60+':   { beginner: 5, intermediate: 6, advanced: 7,  professional: 7  },
};

function getMaxExercises(duration, level) {
  const row = EXERCISE_CAPS[duration] || EXERCISE_CAPS['30-45'];
  return row[level] || row['intermediate'] || 5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reorder muscle groups so that prioritised groups come first
// ─────────────────────────────────────────────────────────────────────────────
function reorderByEmphasis(muscleGroups, prioritise) {
  if (!prioritise || prioritise.length === 0) return muscleGroups;
  const hi  = muscleGroups.filter(g => prioritise.includes(g));
  const lo  = muscleGroups.filter(g => !prioritise.includes(g));
  return [...hi, ...lo];
}

// ─────────────────────────────────────────────────────────────────────────────
// Get available exercises for a muscle group filtered by equipment & difficulty
// ─────────────────────────────────────────────────────────────────────────────
function getAvailableExercises(library, muscleGroup, allowedTiers, allowedDifficulties) {
  const groupData = library[muscleGroup];
  if (!groupData) return [];

  const exercises = [];
  for (const tier of allowedTiers) {
    const tierExercises = (groupData[tier] || [])
      .filter(ex => allowedDifficulties.includes(ex.difficulty));
    exercises.push(...tierExercises);
  }
  // Deduplicate by name (a bodyweight exercise listed under both bw and dumbbell tiers)
  const seen = new Set();
  return exercises.filter(ex => {
    if (seen.has(ex.name)) return false;
    seen.add(ex.name);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Select exercises for a week — deterministic, never random
//
// Pool is sorted: compound first (if compoundFirst), then alphabetically.
// Week 1 & 3 → first slice of pool.
// Week 2 & 4 → second slice (offset by count) so workouts feel fresh.
// ─────────────────────────────────────────────────────────────────────────────
function selectExercisesForWeek(available, count, week, compoundFirst) {
  let pool = [...available];

  if (compoundFirst) {
    pool.sort((a, b) => {
      if (b.isCompound !== a.isCompound) return b.isCompound ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  } else {
    pool.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Alternate between first and second halves every 2 weeks
  const offset = week % 2 === 0 ? Math.min(count, Math.floor(pool.length / 2)) : 0;
  return pool.slice(offset, offset + count);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a human-readable plan name
// ─────────────────────────────────────────────────────────────────────────────
const GOAL_LABELS = {
  build_muscle:     'Muscle Building',
  lose_weight:      'Fat Loss',
  stay_active:      'Active Lifestyle',
  improve_endurance:'Endurance',
  get_toned:        'Toning',
};

const LEVEL_LABELS = {
  beginner:     'Beginner',
  intermediate: 'Intermediate',
  advanced:     'Advanced',
  professional: 'Pro',
};

function buildPlanName(goal, experience, frequency) {
  return `${LEVEL_LABELS[experience] || experience} ${GOAL_LABELS[goal] || goal} — ${frequency}×/week`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise user profile fields — handles both onboarding formats
// ─────────────────────────────────────────────────────────────────────────────
function normaliseProfile(raw) {
  const frequencyRaw = parseInt(raw.daysPerWeek || raw.days || raw.frequency || '3');
  const frequency    = frequencyRaw <= 3 ? 3 : frequencyRaw <= 4 ? 4 : 5;

  // Normalise experience/level
  const lvlRaw   = (raw.fitnessLevel || raw.experience || raw.level || 'beginner').toLowerCase();
  const level    = lvlRaw === 'professional' ? 'professional'
                 : lvlRaw === 'advanced'     ? 'advanced'
                 : lvlRaw === 'intermediate' ? 'intermediate'
                 : 'beginner';

  // Normalise goal
  const goalRaw = (raw.goal || 'stay_active').toLowerCase().replace(/\s+/g, '_');
  const goalMap = {
    build_muscle:     'build_muscle',
    lose_weight:      'lose_weight',
    lose_fat:         'lose_weight',
    stay_active:      'stay_active',
    improve_endurance:'improve_endurance',
    get_toned:        'get_toned',
    toning:           'get_toned',
    // Legacy onboarding strings
    'build muscle':   'build_muscle',
    'lose weight':    'lose_weight',
    'get toned':      'get_toned',
    'stay active':    'stay_active',
    'improve endurance':'improve_endurance',
  };
  const goal = goalMap[goalRaw] || 'stay_active';

  // Normalise equipment
  const equipment = raw.equipment || raw.equipmentTier || 'none';
  let equipTier = 'none';
  if (Array.isArray(equipment)) {
    if (equipment.some(e => /gym|cable|machine/i.test(e)))   equipTier = 'gym_access';
    else if (equipment.some(e => /barbell/i.test(e)))         equipTier = 'has_barbell';
    else if (equipment.some(e => /bench/i.test(e)))           equipTier = 'has_bench';
    else if (equipment.some(e => /dumbbell/i.test(e)))        equipTier = 'has_dumbbells';
  } else if (typeof equipment === 'string') {
    const eq = equipment.toLowerCase();
    if (/gym|gym_access/.test(eq))       equipTier = 'gym_access';
    else if (/barbell/.test(eq))          equipTier = 'has_barbell';
    else if (/bench/.test(eq))            equipTier = 'has_bench';
    else if (/dumbbell/.test(eq))         equipTier = 'has_dumbbells';
    else if (EQUIPMENT_RULES[equipment])  equipTier = equipment;
  }

  const sexRaw = (raw.gender || raw.sex || 'other').toLowerCase();
  const sex    = sexRaw === 'male' ? 'male' : sexRaw === 'female' ? 'female' : 'other';

  const duration = raw.sessionDuration || raw.duration || '30-45';

  return { goal, level, frequency, equipTier, sex, duration, weightLbs: raw.weight };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic 4-week workout plan.
 *
 * @param {object} userProfile  Raw user profile from the DB (or onboarding)
 * @param {object} library      Resolved exercise library from resolveLibrary()
 * @returns {object}            Complete plan ready to store in WorkoutPlan.planJson
 */
function generatePlan(userProfile, library) {
  const { goal, level, frequency, equipTier, sex, duration, weightLbs } = normaliseProfile(userProfile);

  const template   = PLAN_TEMPLATES[
    frequency <= 3 ? 'THREE_DAY' : frequency <= 4 ? 'FOUR_DAY' : 'FIVE_DAY'
  ];
  const goalRules  = GOAL_RULES[goal]     || GOAL_RULES.stay_active;
  const levelRules = LEVEL_RULES[level]   || LEVEL_RULES.beginner;
  const allowedTiers = EQUIPMENT_RULES[equipTier] || ['bodyweight'];
  const sexEmphasis  = SEX_MUSCLE_EMPHASIS[sex]   || SEX_MUSCLE_EMPHASIS.other;
  const maxExercises = getMaxExercises(duration, level);
  const sets         = Math.max(1, levelRules.setsPerExercise + goalRules.setsModifier);
  const durationMins = levelRules.sessionDurationMins[duration] || 40;

  const weeks = [];

  for (let week = 1; week <= 4; week++) {
    const weekSessions = [];

    for (const day of template.schedule) {
      if (day.isRestDay) {
        weekSessions.push({ dayOfWeek: day.dayOfWeek, sessionName: 'Rest Day', isRestDay: true });
        continue;
      }

      const exercises = [];
      const orderedGroups = reorderByEmphasis(day.muscleGroups, sexEmphasis.prioritise);

      for (const muscleGroup of orderedGroups) {
        const available = getAvailableExercises(
          library, muscleGroup, allowedTiers, levelRules.difficultiesAllowed,
        );
        if (available.length === 0) continue;

        const selected = selectExercisesForWeek(
          available, levelRules.exercisesPerMuscleGroup, week, goalRules.compoundFirst,
        );

        for (const ex of selected) {
          const midReps = Math.floor((goalRules.repsPerSet.min + goalRules.repsPerSet.max) / 2);
          exercises.push({
            ymoveId:         ex.ymoveId  || null,
            name:            ex.name,
            muscleGroup,
            difficulty:      ex.difficulty,
            isCompound:      ex.isCompound,
            sets,
            reps:            ex.isTimed ? null   : midReps,
            durationSecs:    ex.isTimed ? ex.defaultDurationSecs : null,
            restSeconds:     goalRules.restSeconds,
            isTimedExercise: ex.isTimed,
          });
        }

        if (exercises.length >= maxExercises) break;
      }

      // Cardio finisher (lose_weight / get_toned / improve_endurance)
      if (goalRules.cardioFinisher && exercises.length < maxExercises) {
        const cardioAvail = getAvailableExercises(
          library, 'cardio', allowedTiers, levelRules.difficultiesAllowed,
        );
        if (cardioAvail.length > 0) {
          const [finisher] = selectExercisesForWeek(cardioAvail, 1, week, false);
          if (finisher) {
            exercises.push({
              ymoveId:         finisher.ymoveId || null,
              name:            finisher.name,
              muscleGroup:     'cardio',
              difficulty:      finisher.difficulty,
              isCompound:      finisher.isCompound,
              sets:            2,
              reps:            finisher.isTimed ? null : 15,
              durationSecs:    finisher.isTimed ? finisher.defaultDurationSecs : null,
              restSeconds:     20,
              isTimedExercise: finisher.isTimed,
              isFinisher:      true,
            });
          }
        }
      }

      const finalExercises = exercises.slice(0, maxExercises);
      const calories = calculateCalories(weightLbs, durationMins, goal, goalRules.calorieMultiplier);

      weekSessions.push({
        dayOfWeek:         day.dayOfWeek,
        sessionName:       `${day.sessionName} — Week ${week}`,
        muscleGroupFocus:  day.muscleGroups,
        focus:             day.focus,
        exercises:         finalExercises,
        exerciseCount:     finalExercises.length,
        durationMins,
        calories,
        type:              goalRules.workoutType,
        isRestDay:         false,
      });
    }

    weeks.push({ weekNumber: week, sessions: weekSessions });
  }

  return {
    planName:   buildPlanName(goal, level, frequency),
    goal,
    level,
    frequency,
    equipTier,
    sex,
    sessionDuration: duration,
    totalWeeks: 4,
    generatedAt: new Date().toISOString(),
    weeks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate a generated plan — returns { valid: bool, errors: string[] }
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
        if (!ex.name) errors.push(`Week ${week.weekNumber} ${session.dayOfWeek}: exercise missing name`);
        if (!ex.sets || ex.sets < 1) errors.push(`${ex.name}: sets must be >= 1`);
        if (!ex.isTimedExercise && (!ex.reps || ex.reps < 1)) {
          errors.push(`${ex.name}: non-timed exercise missing reps`);
        }
        if (ex.isTimedExercise && !ex.durationSecs) {
          errors.push(`${ex.name}: timed exercise missing durationSecs`);
        }
      }
    }
  }

  if (totalExercises === 0) errors.push('Plan contains no exercises at all');

  return { valid: errors.length === 0, errors, totalExercises };
}

module.exports = {
  generatePlan,
  validatePlan,
  normaliseProfile,
  // Exported for testing
  GOAL_RULES,
  LEVEL_RULES,
  EQUIPMENT_RULES,
  SEX_MUSCLE_EMPHASIS,
  EXERCISE_CAPS,
  calculateCalories,
  getMaxExercises,
};
