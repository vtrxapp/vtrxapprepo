// ─────────────────────────────────────────────────────────────────────────────
// data/exerciseLibrary.js — Curated exercise specifications
//
// Each entry defines exercise metadata. ymoveId is resolved at startup from
// the exercises table (matched by name + muscleGroup). Video URLs are NEVER
// stored here because they expire every 48 hours — always fetch them fresh
// from the /workouts/exercise-video/:ymoveId endpoint at display time.
//
// Equipment tiers (determines which exercises are available to a user):
//   bodyweight — no equipment required
//   dumbbells  — requires dumbbells
//   gym        — requires cables / machines / barbell
//
// Run scripts/populateExerciseLibrary.js on Railway to back-fill ymove IDs.
// ─────────────────────────────────────────────────────────────────────────────

// In-memory cache populated by resolveLibrary()
let _resolved = null;

// ─────────────────────────────────────────────────────────────────────────────
// CURATED EXERCISE SPECIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

const CURATED = {
  chest: {
    bodyweight: [
      { name: 'Push-Up',          muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Wide Push-Up',     muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Diamond Push-Up',  muscleGroup: 'Chest', difficulty: 'INTERMEDIATE', isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Decline Push-Up',  muscleGroup: 'Chest', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Incline Push-Up',  muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 15, defaultDurationSecs: null },
    ],
    dumbbells: [
      { name: 'Dumbbell Chest Press', muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Dumbbell Fly',         muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Incline Dumbbell Press', muscleGroup: 'Chest', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Floor Press',          muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Dumbbell Pullover',    muscleGroup: 'Chest', difficulty: 'INTERMEDIATE', isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Barbell Bench Press',  muscleGroup: 'Chest', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Cable Fly',            muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Incline Barbell Press',muscleGroup: 'Chest', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Pec Deck Fly',         muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Cable Chest Press',    muscleGroup: 'Chest', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
  },

  back: {
    bodyweight: [
      { name: 'Pull-Up',         muscleGroup: 'Back', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 6,  defaultDurationSecs: null },
      { name: 'Chin-Up',         muscleGroup: 'Back', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 6,  defaultDurationSecs: null },
      { name: 'Inverted Row',    muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Superman',        muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Dead Hang',       muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: false, isTimed: true,  defaultReps: null, defaultDurationSecs: 30 },
    ],
    dumbbells: [
      { name: 'Dumbbell Row',          muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Bent Over Row',         muscleGroup: 'Back', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Renegade Row',          muscleGroup: 'Back', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Dumbbell Deadlift',     muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Rear Delt Row',         muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Lat Pulldown',        muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Seated Cable Row',    muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'T-Bar Row',           muscleGroup: 'Back', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Barbell Row',         muscleGroup: 'Back', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Chest Supported Row', muscleGroup: 'Back', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
    ],
  },

  shoulders: {
    bodyweight: [
      { name: 'Pike Push-Up',         muscleGroup: 'Shoulders', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Wall Handstand Hold',  muscleGroup: 'Shoulders', difficulty: 'ADVANCED',     isCompound: false, isTimed: true,  defaultReps: null, defaultDurationSecs: 20 },
      { name: 'Arm Circles',          muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: true,  defaultReps: null, defaultDurationSecs: 30 },
      { name: 'Band Pull-Apart',      muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Shoulder Tap Push-Up', muscleGroup: 'Shoulders', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
    ],
    dumbbells: [
      { name: 'Dumbbell Shoulder Press', muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Lateral Raise',           muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Front Raise',             muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Arnold Press',            muscleGroup: 'Shoulders', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Rear Delt Fly',           muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Barbell Overhead Press', muscleGroup: 'Shoulders', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Cable Lateral Raise',    muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Machine Shoulder Press', muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Face Pull',              muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Cable Front Raise',      muscleGroup: 'Shoulders', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
  },

  biceps: {
    bodyweight: [
      { name: 'Chin-Up',      muscleGroup: 'Biceps', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Inverted Row', muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Flex Hang',    muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: true,  defaultReps: null, defaultDurationSecs: 20 },
    ],
    dumbbells: [
      { name: 'Dumbbell Bicep Curl',  muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Hammer Curl',          muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Concentration Curl',   muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Incline Dumbbell Curl',muscleGroup: 'Biceps', difficulty: 'INTERMEDIATE', isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Reverse Curl',         muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Barbell Curl',      muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Cable Curl',        muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Preacher Curl',     muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Machine Bicep Curl',muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'EZ Bar Curl',       muscleGroup: 'Biceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
    ],
  },

  triceps: {
    bodyweight: [
      { name: 'Tricep Dip',           muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Diamond Push-Up',      muscleGroup: 'Triceps', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Close Grip Push-Up',   muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
    dumbbells: [
      { name: 'Dumbbell Tricep Extension', muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Skull Crusher',             muscleGroup: 'Triceps', difficulty: 'INTERMEDIATE', isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Tricep Kickback',           muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Close Grip Dumbbell Press', muscleGroup: 'Triceps', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Overhead Tricep Extension',  muscleGroup: 'Triceps', difficulty: 'BEGINNER',    isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Cable Pushdown',            muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Rope Pushdown',             muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Cable Overhead Extension',  muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Machine Dip',               muscleGroup: 'Triceps', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Close Grip Bench Press',    muscleGroup: 'Triceps', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
    ],
  },

  legs: {
    bodyweight: [
      { name: 'Bodyweight Squat',  muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Jump Squat',        muscleGroup: 'Legs', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Reverse Lunge',     muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Step-Up',           muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Wall Sit',          muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: false, isTimed: true,  defaultReps: null, defaultDurationSecs: 40 },
    ],
    dumbbells: [
      { name: 'Goblet Squat',          muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Dumbbell Lunge',        muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Romanian Deadlift',     muscleGroup: 'Legs', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Dumbbell Split Squat',  muscleGroup: 'Legs', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Sumo Squat',            muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Barbell Back Squat',  muscleGroup: 'Legs', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Leg Press',           muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Leg Extension',       muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Leg Curl',            muscleGroup: 'Legs', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Hack Squat',          muscleGroup: 'Legs', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
    ],
  },

  glutes: {
    bodyweight: [
      { name: 'Glute Bridge',               muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Hip Thrust',                 muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Donkey Kick',                muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Fire Hydrant',               muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Single Leg Glute Bridge',    muscleGroup: 'Glutes', difficulty: 'INTERMEDIATE', isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
    ],
    dumbbells: [
      { name: 'Dumbbell Hip Thrust',   muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Romanian Deadlift',     muscleGroup: 'Glutes', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Single Leg Deadlift',   muscleGroup: 'Glutes', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Dumbbell Step-Up',      muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Sumo Deadlift',         muscleGroup: 'Glutes', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Hip Thrust Machine',    muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 12, defaultDurationSecs: null },
      { name: 'Cable Hip Kickback',    muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Cable Pull-Through',    muscleGroup: 'Glutes', difficulty: 'BEGINNER',     isCompound: true,  isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Glute Ham Raise',       muscleGroup: 'Glutes', difficulty: 'ADVANCED',     isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Barbell Hip Thrust',    muscleGroup: 'Glutes', difficulty: 'INTERMEDIATE', isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
    ],
  },

  core: {
    bodyweight: [
      { name: 'Plank',            muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: true,  defaultReps: null, defaultDurationSecs: 40 },
      { name: 'Crunch',           muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Russian Twist',    muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 20, defaultDurationSecs: null },
      { name: 'Mountain Climber', muscleGroup: 'Core', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: true,  defaultReps: null, defaultDurationSecs: 30 },
      { name: 'Dead Bug',         muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
    ],
    dumbbells: [
      { name: 'Dumbbell Russian Twist', muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 20, defaultDurationSecs: null },
      { name: 'Weighted Crunch',        muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Dumbbell Side Bend',     muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Cable Crunch',        muscleGroup: 'Core', difficulty: 'BEGINNER',     isCompound: false, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Hanging Leg Raise',   muscleGroup: 'Core', difficulty: 'INTERMEDIATE', isCompound: false, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Ab Wheel Rollout',    muscleGroup: 'Core', difficulty: 'ADVANCED',     isCompound: false, isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
    ],
  },

  cardio: {
    bodyweight: [
      { name: 'Jumping Jacks', muscleGroup: 'Cardio', difficulty: 'BEGINNER',     isCompound: true,  isTimed: true,  defaultReps: null, defaultDurationSecs: 40 },
      { name: 'Burpees',       muscleGroup: 'Cardio', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'High Knees',    muscleGroup: 'Cardio', difficulty: 'BEGINNER',     isCompound: true,  isTimed: true,  defaultReps: null, defaultDurationSecs: 30 },
      { name: 'Box Jump',      muscleGroup: 'Cardio', difficulty: 'INTERMEDIATE', isCompound: true,  isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Jump Rope',     muscleGroup: 'Cardio', difficulty: 'BEGINNER',     isCompound: true,  isTimed: true,  defaultReps: null, defaultDurationSecs: 60 },
    ],
    dumbbells: [
      { name: 'Dumbbell Swing',    muscleGroup: 'Cardio', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Dumbbell Thruster', muscleGroup: 'Cardio', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Man Maker',         muscleGroup: 'Cardio', difficulty: 'ADVANCED',     isCompound: true, isTimed: false, defaultReps: 6,  defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Treadmill Sprint',  muscleGroup: 'Cardio', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: true, defaultReps: null, defaultDurationSecs: 60 },
      { name: 'Rowing Machine',    muscleGroup: 'Cardio', difficulty: 'BEGINNER',     isCompound: true, isTimed: true, defaultReps: null, defaultDurationSecs: 60 },
      { name: 'Stationary Bike',   muscleGroup: 'Cardio', difficulty: 'BEGINNER',     isCompound: true, isTimed: true, defaultReps: null, defaultDurationSecs: 60 },
      { name: 'Stair Climber',     muscleGroup: 'Cardio', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: true, defaultReps: null, defaultDurationSecs: 60 },
      { name: 'Elliptical',        muscleGroup: 'Cardio', difficulty: 'BEGINNER',     isCompound: true, isTimed: true, defaultReps: null, defaultDurationSecs: 60 },
    ],
  },

  full_body: {
    bodyweight: [
      { name: 'Burpee',           muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Bear Crawl',       muscleGroup: 'Full Body', difficulty: 'BEGINNER',     isCompound: true, isTimed: true,  defaultReps: null, defaultDurationSecs: 30 },
      { name: 'Turkish Get-Up',   muscleGroup: 'Full Body', difficulty: 'ADVANCED',     isCompound: true, isTimed: false, defaultReps: 5,  defaultDurationSecs: null },
      { name: 'Jumping Lunge',    muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Inchworm',         muscleGroup: 'Full Body', difficulty: 'BEGINNER',     isCompound: true, isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
    ],
    dumbbells: [
      { name: 'Clean and Press',    muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Dumbbell Thruster',  muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 10, defaultDurationSecs: null },
      { name: 'Dumbbell Snatch',    muscleGroup: 'Full Body', difficulty: 'ADVANCED',     isCompound: true, isTimed: false, defaultReps: 6,  defaultDurationSecs: null },
      { name: 'Dumbbell Swing',     muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 15, defaultDurationSecs: null },
      { name: 'Renegade Row',       muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
    ],
    gym: [
      { name: 'Deadlift',          muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 6,  defaultDurationSecs: null },
      { name: 'Power Clean',       muscleGroup: 'Full Body', difficulty: 'ADVANCED',     isCompound: true, isTimed: false, defaultReps: 5,  defaultDurationSecs: null },
      { name: 'Barbell Thruster',  muscleGroup: 'Full Body', difficulty: 'ADVANCED',     isCompound: true, isTimed: false, defaultReps: 6,  defaultDurationSecs: null },
      { name: 'Trap Bar Deadlift', muscleGroup: 'Full Body', difficulty: 'INTERMEDIATE', isCompound: true, isTimed: false, defaultReps: 8,  defaultDurationSecs: null },
      { name: 'Barbell Complex',   muscleGroup: 'Full Body', difficulty: 'ADVANCED',     isCompound: true, isTimed: false, defaultReps: 6,  defaultDurationSecs: null },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE — enrich each curated entry with ymoveId from the Exercise table
// Call once at server startup (or on first plan generation) and cache result.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveLibrary(prisma) {
  if (_resolved) return _resolved;

  // Load all exercises from DB that have a ymoveId into a lookup map
  const dbExercises = await prisma.exercise.findMany({
    where:  { ymoveId: { not: null } },
    select: { name: true, muscleGroup: true, equipment: true, ymoveId: true, thumbnailUrl: true },
  });

  // Build lookup: normalised name → DB record
  const byName = new Map();
  for (const ex of dbExercises) {
    byName.set(_normName(ex.name), ex);
  }

  const resolved = {};
  let totalResolved = 0;
  let totalMissing  = 0;

  for (const [group, tiers] of Object.entries(CURATED)) {
    resolved[group] = {};
    for (const [tier, specs] of Object.entries(tiers)) {
      resolved[group][tier] = specs.map(spec => {
        const dbMatch = byName.get(_normName(spec.name));
        if (dbMatch) {
          totalResolved++;
          return { ...spec, ymoveId: dbMatch.ymoveId };
        }
        // Not in DB yet — ymoveId null; populateExerciseLibrary.js will fix this
        totalMissing++;
        return { ...spec, ymoveId: null };
      });
    }
  }

  console.log(`[exerciseLibrary] Resolved ${totalResolved} exercises, ${totalMissing} pending DB population`);
  _resolved = resolved;
  return _resolved;
}

// Clear cached resolution (e.g. after populateExerciseLibrary.js runs)
function invalidateCache() {
  _resolved = null;
}

// Case-insensitive, punctuation-stripped name comparison
function _normName(name) {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Return a flat array of all curated exercises (with ymoveIds if resolved)
function getAllExercises(library) {
  return Object.values(library).flatMap(tiers => Object.values(tiers).flat());
}

module.exports = { CURATED, resolveLibrary, invalidateCache, getAllExercises };
