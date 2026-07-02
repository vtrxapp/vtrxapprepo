// ─────────────────────────────────────────────────────────────────────────────
// data/exerciseLibrary.js — VTRX MVP Exercise Bank
//
// Each movement is defined once, with three equipment variants:
//   gym        → barbell / cable / machine available
//   dumbbells  → only dumbbells available
//   none       → bodyweight only
//
// This is the single source of truth consumed by planGenerator.js.
// Video URLs are never stored here — fetch fresh from the ymove API.
// ─────────────────────────────────────────────────────────────────────────────

const ex = (name, muscleGroup, isCompound, isTimed, reps, secs = null) => ({
  name, muscleGroup, isCompound, isTimed,
  defaultReps:         isTimed ? null : reps,
  defaultDurationSecs: isTimed ? (secs || 30) : null,
});

// ── PUSH movements ────────────────────────────────────────────────────────────
const BENCH = {
  gym:        ex('Barbell Bench Press',   'Chest',    true,  false, 8),
  dumbbells:  ex('Dumbbell Chest Press',  'Chest',    true,  false, 10),
  none:       ex('Push-Up',              'Chest',    true,  false, 12),
};

const SHOULDER_PRESS = {
  gym:        ex('Overhead Press',          'Shoulders', true, false, 8),
  dumbbells:  ex('Dumbbell Shoulder Press', 'Shoulders', true, false, 10),
  none:       ex('Pike Push-Up',            'Shoulders', true, false, 10),
};

const TRICEP_PUSHDOWN = {
  gym:        ex('Cable Tricep Pushdown',      'Triceps', false, false, 12),
  dumbbells:  ex('Dumbbell Overhead Extension','Triceps', false, false, 12),
  none:       ex('Diamond Push-Up',            'Triceps', false, false, 10),
};

const INCLINE_PRESS = {
  gym:        ex('Incline Barbell Press',  'Chest',     true,  false, 8),
  dumbbells:  ex('Incline Dumbbell Press', 'Chest',     true,  false, 10),
  none:       ex('Decline Push-Up',        'Chest',     true,  false, 10),
};

const LATERAL_RAISE = {
  gym:        ex('Cable Lateral Raise',    'Shoulders', false, false, 15),
  dumbbells:  ex('Dumbbell Lateral Raise', 'Shoulders', false, false, 15),
  none:       ex('Plank Shoulder Taps',    'Shoulders', false, false, 16),
};

// ── PULL movements ────────────────────────────────────────────────────────────
const LAT_PULLDOWN = {
  gym:        ex('Lat Pulldown',      'Back', true,  false, 10),
  dumbbells:  ex('Dumbbell Pullover', 'Back', false, false, 12),
  none:       ex('Pull-Up',          'Back', true,  false, 6),
};

const ROW = {
  gym:        ex('Seated Cable Row', 'Back', true, false, 10),
  dumbbells:  ex('Dumbbell Row',     'Back', true, false, 10),
  none:       ex('Inverted Row',     'Back', true, false, 10),
};

const BICEP_CURL = {
  gym:        ex('EZ Bar Curl',        'Biceps', false, false, 12),
  dumbbells:  ex('Dumbbell Bicep Curl','Biceps', false, false, 12),
  none:       ex('Isometric Curl',     'Biceps', false, false, 15),
};

const FACE_PULL = {
  gym:        ex('Cable Face Pull',        'Back', false, false, 15),
  dumbbells:  ex('Dumbbell Rear Delt Fly', 'Back', false, false, 15),
  none:       ex('Prone Y-Raise',          'Back', false, false, 15),
};

const SUPERMAN = {
  gym:        ex('Back Extension',  'Back', false, false, 15),
  dumbbells:  ex('Superman Hold',   'Back', false, true,  null, 30),
  none:       ex('Superman Hold',   'Back', false, true,  null, 30),
};

// ── LEGS movements ────────────────────────────────────────────────────────────
const SQUAT = {
  gym:        ex('Barbell Squat', 'Legs', true, false, 8),
  dumbbells:  ex('Goblet Squat',  'Legs', true, false, 10),
  none:       ex('Air Squat',    'Legs', true, false, 15),
};

const RDL = {
  gym:        ex('Barbell Romanian Deadlift','Legs', true, false, 8),
  dumbbells:  ex('Dumbbell RDL',            'Legs', true, false, 10),
  none:       ex('Single-Leg RDL',          'Legs', true, false, 10),
};

const LUNGE = {
  gym:        ex('Barbell Lunge',   'Legs', true, false, 10),
  dumbbells:  ex('Dumbbell Lunge',  'Legs', true, false, 10),
  none:       ex('Walking Lunge',   'Legs', true, false, 12),
};

const CALF_RAISE = {
  gym:        ex('Machine Calf Raise',  'Legs', false, false, 15),
  dumbbells:  ex('Standing Calf Raise', 'Legs', false, false, 20),
  none:       ex('Calf Raise',          'Legs', false, false, 25),
};

// ── CORE movements ────────────────────────────────────────────────────────────
const PLANK = {
  gym:        ex('Plank', 'Core', false, true, null, 30),
  dumbbells:  ex('Plank', 'Core', false, true, null, 30),
  none:       ex('Plank', 'Core', false, true, null, 30),
};

const CRUNCHES = {
  gym:        ex('Crunches', 'Core', false, false, 15),
  dumbbells:  ex('Crunches', 'Core', false, false, 15),
  none:       ex('Crunches', 'Core', false, false, 15),
};

// ── Exported movement map ─────────────────────────────────────────────────────
// planGenerator.js picks from this map by movement key + equipment tier.
module.exports = {
  BENCH, SHOULDER_PRESS, TRICEP_PUSHDOWN, INCLINE_PRESS, LATERAL_RAISE,
  LAT_PULLDOWN, ROW, BICEP_CURL, FACE_PULL, SUPERMAN,
  SQUAT, RDL, LUNGE, CALF_RAISE,
  PLANK, CRUNCHES,
};
