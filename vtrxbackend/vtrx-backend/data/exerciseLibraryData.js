// data/exerciseLibraryData.js — Flat exercise bank for the AI plan generator
//
// 16 movements × 3 equipment tiers = 48 entries.
// IDs are stable slugs so the AI can reference them and the DB uses them as PKs.
// defaultSecs is only set for timed exercises; defaultReps is only set for rep-based.

const EXERCISES = [
  // ── BENCH ─────────────────────────────────────────────────────────────────
  { id: 'BENCH_GYM',       name: 'Barbell Bench Press',       muscleGroup: 'Chest',     equipment: 'barbell',    difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultSecs: null },
  { id: 'BENCH_DUMBBELLS', name: 'Dumbbell Chest Press',      muscleGroup: 'Chest',     equipment: 'dumbbell',   difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'BENCH_NONE',      name: 'Push-Up',                   muscleGroup: 'Chest',     equipment: 'bodyweight', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultSecs: null },

  // ── SHOULDER_PRESS ────────────────────────────────────────────────────────
  { id: 'SHOULDER_PRESS_GYM',       name: 'Overhead Press',          muscleGroup: 'Shoulders', equipment: 'barbell',    difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultSecs: null },
  { id: 'SHOULDER_PRESS_DUMBBELLS', name: 'Dumbbell Shoulder Press', muscleGroup: 'Shoulders', equipment: 'dumbbell',   difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'SHOULDER_PRESS_NONE',      name: 'Pike Push-Up',            muscleGroup: 'Shoulders', equipment: 'bodyweight', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultSecs: null },

  // ── TRICEP_PUSHDOWN ───────────────────────────────────────────────────────
  { id: 'TRICEP_PUSHDOWN_GYM',       name: 'Cable Tricep Pushdown',       muscleGroup: 'Triceps', equipment: 'cable',      difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 12, defaultSecs: null },
  { id: 'TRICEP_PUSHDOWN_DUMBBELLS', name: 'Dumbbell Overhead Extension', muscleGroup: 'Triceps', equipment: 'dumbbell',   difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 12, defaultSecs: null },
  { id: 'TRICEP_PUSHDOWN_NONE',      name: 'Diamond Push-Up',             muscleGroup: 'Triceps', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 10, defaultSecs: null },

  // ── INCLINE_PRESS ─────────────────────────────────────────────────────────
  { id: 'INCLINE_PRESS_GYM',       name: 'Incline Barbell Press', muscleGroup: 'Chest', equipment: 'barbell',    difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 8,  defaultSecs: null },
  { id: 'INCLINE_PRESS_DUMBBELLS', name: 'Incline Dumbbell Press', muscleGroup: 'Chest', equipment: 'dumbbell',   difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'INCLINE_PRESS_NONE',      name: 'Decline Push-Up',        muscleGroup: 'Chest', equipment: 'bodyweight', difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },

  // ── LATERAL_RAISE ─────────────────────────────────────────────────────────
  { id: 'LATERAL_RAISE_GYM',       name: 'Cable Lateral Raise',   muscleGroup: 'Shoulders', equipment: 'cable',      difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
  { id: 'LATERAL_RAISE_DUMBBELLS', name: 'Dumbbell Lateral Raise', muscleGroup: 'Shoulders', equipment: 'dumbbell',   difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
  { id: 'LATERAL_RAISE_NONE',      name: 'Plank Shoulder Taps',    muscleGroup: 'Shoulders', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 16, defaultSecs: null },

  // ── LAT_PULLDOWN ──────────────────────────────────────────────────────────
  { id: 'LAT_PULLDOWN_GYM',       name: 'Lat Pulldown',     muscleGroup: 'Back', equipment: 'machine',    difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'LAT_PULLDOWN_DUMBBELLS', name: 'Dumbbell Pullover', muscleGroup: 'Back', equipment: 'dumbbell',   difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultSecs: null },
  { id: 'LAT_PULLDOWN_NONE',      name: 'Pull-Up',           muscleGroup: 'Back', equipment: 'bodyweight', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 6,  defaultSecs: null },

  // ── ROW ───────────────────────────────────────────────────────────────────
  { id: 'ROW_GYM',       name: 'Seated Cable Row', muscleGroup: 'Back', equipment: 'cable',      difficulty: 'BEGINNER', isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'ROW_DUMBBELLS', name: 'Dumbbell Row',      muscleGroup: 'Back', equipment: 'dumbbell',   difficulty: 'BEGINNER', isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'ROW_NONE',      name: 'Inverted Row',      muscleGroup: 'Back', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },

  // ── BICEP_CURL ────────────────────────────────────────────────────────────
  { id: 'BICEP_CURL_GYM',       name: 'EZ Bar Curl',         muscleGroup: 'Biceps', equipment: 'barbell',    difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 12, defaultSecs: null },
  { id: 'BICEP_CURL_DUMBBELLS', name: 'Dumbbell Bicep Curl', muscleGroup: 'Biceps', equipment: 'dumbbell',   difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 12, defaultSecs: null },
  { id: 'BICEP_CURL_NONE',      name: 'Isometric Curl',       muscleGroup: 'Biceps', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },

  // ── FACE_PULL ─────────────────────────────────────────────────────────────
  { id: 'FACE_PULL_GYM',       name: 'Cable Face Pull',        muscleGroup: 'Back', equipment: 'cable',      difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
  { id: 'FACE_PULL_DUMBBELLS', name: 'Dumbbell Rear Delt Fly', muscleGroup: 'Back', equipment: 'dumbbell',   difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
  { id: 'FACE_PULL_NONE',      name: 'Prone Y-Raise',           muscleGroup: 'Back', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },

  // ── SUPERMAN ──────────────────────────────────────────────────────────────
  { id: 'SUPERMAN_GYM',       name: 'Back Extension', muscleGroup: 'Back', equipment: 'machine',    difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15,   defaultSecs: null },
  { id: 'SUPERMAN_DUMBBELLS', name: 'Superman Hold',  muscleGroup: 'Back', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: true,  defaultReps: null, defaultSecs: 30 },
  { id: 'SUPERMAN_NONE',      name: 'Superman Hold',  muscleGroup: 'Back', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: true,  defaultReps: null, defaultSecs: 30 },

  // ── SQUAT ─────────────────────────────────────────────────────────────────
  { id: 'SQUAT_GYM',       name: 'Barbell Squat', muscleGroup: 'Legs', equipment: 'barbell',    difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 8,  defaultSecs: null },
  { id: 'SQUAT_DUMBBELLS', name: 'Goblet Squat',  muscleGroup: 'Legs', equipment: 'dumbbell',   difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'SQUAT_NONE',      name: 'Air Squat',     muscleGroup: 'Legs', equipment: 'bodyweight', difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 15, defaultSecs: null },

  // ── RDL ───────────────────────────────────────────────────────────────────
  { id: 'RDL_GYM',       name: 'Barbell Romanian Deadlift', muscleGroup: 'Legs', equipment: 'barbell',    difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 8,  defaultSecs: null },
  { id: 'RDL_DUMBBELLS', name: 'Dumbbell RDL',              muscleGroup: 'Legs', equipment: 'dumbbell',   difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'RDL_NONE',      name: 'Single-Leg RDL',            muscleGroup: 'Legs', equipment: 'bodyweight', difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },

  // ── LUNGE ─────────────────────────────────────────────────────────────────
  { id: 'LUNGE_GYM',       name: 'Barbell Lunge',  muscleGroup: 'Legs', equipment: 'barbell',    difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'LUNGE_DUMBBELLS', name: 'Dumbbell Lunge', muscleGroup: 'Legs', equipment: 'dumbbell',   difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 10, defaultSecs: null },
  { id: 'LUNGE_NONE',      name: 'Walking Lunge',  muscleGroup: 'Legs', equipment: 'bodyweight', difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 12, defaultSecs: null },

  // ── CALF_RAISE ────────────────────────────────────────────────────────────
  { id: 'CALF_RAISE_GYM',       name: 'Machine Calf Raise',  muscleGroup: 'Legs', equipment: 'machine',    difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
  { id: 'CALF_RAISE_DUMBBELLS', name: 'Standing Calf Raise', muscleGroup: 'Legs', equipment: 'dumbbell',   difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 20, defaultSecs: null },
  { id: 'CALF_RAISE_NONE',      name: 'Calf Raise',          muscleGroup: 'Legs', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 25, defaultSecs: null },

  // ── PLANK ─────────────────────────────────────────────────────────────────
  { id: 'PLANK_GYM',       name: 'Plank', muscleGroup: 'Core', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: true, defaultReps: null, defaultSecs: 30 },
  { id: 'PLANK_DUMBBELLS', name: 'Plank', muscleGroup: 'Core', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: true, defaultReps: null, defaultSecs: 30 },
  { id: 'PLANK_NONE',      name: 'Plank', muscleGroup: 'Core', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: true, defaultReps: null, defaultSecs: 30 },

  // ── CRUNCHES ──────────────────────────────────────────────────────────────
  { id: 'CRUNCHES_GYM',       name: 'Crunches', muscleGroup: 'Core', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
  { id: 'CRUNCHES_DUMBBELLS', name: 'Crunches', muscleGroup: 'Core', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
  { id: 'CRUNCHES_NONE',      name: 'Crunches', muscleGroup: 'Core', equipment: 'bodyweight', difficulty: 'BEGINNER', isCompound: false, isTimed: false, defaultReps: 15, defaultSecs: null },
];

module.exports = EXERCISES;
