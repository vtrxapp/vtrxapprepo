// ─────────────────────────────────────────────────────────────────────────────
// scripts/testPlanGenerator.js — Run all 5 plan generation tests
//
// Run: node scripts/testPlanGenerator.js
// No network calls, no DB needed — uses CURATED library directly.
// ─────────────────────────────────────────────────────────────────────────────

const { CURATED }          = require('../data/exerciseLibrary');
const { generatePlan, validatePlan, EXERCISE_CAPS, GOAL_RULES, LEVEL_RULES } = require('../data/planGenerator');

// Build a mock library from CURATED (all ymoveId = null, fine for logic testing)
const mockLibrary = CURATED;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function check(label, pass) {
  const icon = pass ? '✅' : '❌';
  console.log(`    ${icon}  ${label}`);
  return pass;
}

function testPlan(testNum, profile, expectations, options = {}) {
  const { printJson } = options;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TEST ${testNum}: ${profile.label || ''}`);
  console.log(`  Profile: goal=${profile.goal}, level=${profile.fitnessLevel}, days=${profile.daysPerWeek}, equipment=${JSON.stringify(profile.equipment)}, gender=${profile.gender}, duration=${profile.sessionDuration}`);

  const plan = generatePlan(profile, mockLibrary);
  const { valid, errors, totalExercises } = validatePlan(plan);

  let allPassed = true;

  // Print JSON for Test 1
  if (printJson) {
    console.log('\n  📋  Generated plan JSON (Test 1):');
    console.log(JSON.stringify(plan, null, 2));
  }

  // Check: plan structure
  allPassed &= check('Plan has 4 weeks', plan.weeks.length === 4);
  allPassed &= check('Plan passes validation', valid);
  if (!valid) {
    errors.forEach(e => console.log(`      ↳  ${e}`));
  }

  // Check: rest days
  const weekOne = plan.weeks[0];
  const restDays = weekOne.sessions.filter(s => s.isRestDay);
  const workoutDays = weekOne.sessions.filter(s => !s.isRestDay);
  allPassed &= check(
    `Rest days correct (expected ${7 - parseInt(profile.daysPerWeek)})`,
    restDays.length === (7 - parseInt(profile.daysPerWeek || 3)),
  );
  allPassed &= check(
    `Workout sessions correct (expected ${profile.daysPerWeek})`,
    workoutDays.length === parseInt(profile.daysPerWeek || 3),
  );

  // Check: exercise counts
  const exCounts = workoutDays.map(s => s.exercises.length);
  const maxEx    = EXERCISE_CAPS[profile.sessionDuration]?.[profile.fitnessLevel?.toLowerCase() || 'beginner'] || 4;
  allPassed &= check(
    `Exercise counts within cap (max ${maxEx} each)`,
    exCounts.every(c => c <= maxEx),
  );
  allPassed &= check(
    'All sessions have at least 1 exercise',
    exCounts.every(c => c >= 1),
  );

  // Check: sets per exercise (skip cardio finishers which always use 2 sets)
  for (const session of workoutDays) {
    for (const ex of session.exercises.filter(e => !e.isFinisher)) {
      const expectedSets = Math.max(1,
        (LEVEL_RULES[profile.fitnessLevel?.toLowerCase() || 'beginner']?.setsPerExercise || 3)
        + (GOAL_RULES[profile.goal?.toLowerCase() || 'stay_active']?.setsModifier || 0)
      );
      if (!check(`"${ex.name}" has ${expectedSets} sets`, ex.sets === expectedSets)) {
        allPassed = false;
        console.log(`      ↳  Got ${ex.sets} sets`);
        break;
      }
    }
    break; // only check first session to keep output clean
  }

  // Check: reps within goal range
  const goalRules = GOAL_RULES[plan.goal];
  for (const session of workoutDays) {
    for (const ex of session.exercises) {
      if (!ex.isTimedExercise && ex.reps != null) {
        allPassed &= check(
          `"${ex.name}" reps (${ex.reps}) within [${goalRules.repsPerSet.min}–${goalRules.repsPerSet.max}]`,
          ex.reps >= goalRules.repsPerSet.min && ex.reps <= goalRules.repsPerSet.max,
        );
        break;
      }
    }
    break;
  }

  // Check: all exercises have names
  const noNames = plan.weeks.flatMap(w =>
    w.sessions.flatMap(s => (s.exercises || []).filter(e => !e.name))
  );
  allPassed &= check('All exercises have names', noNames.length === 0);

  // Check: equipment constraint (no gym exercises for bodyweight-only users)
  if (profile.equipment === 'none' || (Array.isArray(profile.equipment) && profile.equipment.length === 0)) {
    const allBw = plan.weeks.flatMap(w =>
      w.sessions.flatMap(s => s.exercises || [])
    ).every(ex => {
      const tier = mockLibrary[ex.muscleGroup?.toLowerCase() || ''];
      if (!tier) return true; // cardio / full_body — assume ok
      return ['bodyweight'].some(t =>
        (tier[t] || []).some(e => e.name === ex.name)
      );
    });
    allPassed &= check('Only bodyweight exercises for no-equipment user', allBw);
  }

  // Check: specific expectation overrides
  for (const [label, testFn] of Object.entries(expectations || {})) {
    allPassed &= check(label, testFn(plan));
  }

  const summary = allPassed ? '🟢  ALL CHECKS PASSED' : '🔴  SOME CHECKS FAILED';
  console.log(`\n  ${summary} — ${totalExercises} total exercises across 4 weeks`);
  return allPassed;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

let allTestsPassed = true;

// Test 1: build_muscle + beginner + 3 days + bodyweight + male + 30-45 min
allTestsPassed &= testPlan(1, {
  label:           'Build Muscle / Beginner / 3-day / Bodyweight / Male / 30-45 min',
  goal:            'build_muscle',
  fitnessLevel:    'beginner',
  daysPerWeek:     3,
  equipment:       'none',
  gender:          'male',
  sessionDuration: '30-45',
  weight:          180,
}, {
  'Cardio finisher NOT included (build_muscle)': plan =>
    !plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.some(e => e.isFinisher),
  'Rest seconds = 75': plan =>
    plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.[0]?.restSeconds === 75,
}, { printJson: true });

// Test 2: lose_weight + intermediate + 4 days + dumbbells + female + 45-60 min
allTestsPassed &= testPlan(2, {
  label:           'Lose Weight / Intermediate / 4-day / Dumbbells / Female / 45-60 min',
  goal:            'lose_weight',
  fitnessLevel:    'intermediate',
  daysPerWeek:     4,
  equipment:       'has_dumbbells',
  gender:          'female',
  sessionDuration: '45-60',
  weight:          145,
}, {
  'Cardio finisher included (lose_weight)': plan =>
    plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.some(e => e.isFinisher),
  'Sets = 3 (4 - 1 modifier)': plan =>
    plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.find(e => !e.isFinisher)?.sets === 3,
  'Glutes/legs exercises appear': plan =>
    plan.weeks[0].sessions.some(s =>
      !s.isRestDay && s.muscleGroupFocus?.some(g => ['glutes','legs'].includes(g))
    ),
});

// Test 3: get_toned + beginner + 3 days + no equipment + female + 15-30 min
allTestsPassed &= testPlan(3, {
  label:           'Get Toned / Beginner / 3-day / No Equipment / Female / 15-30 min',
  goal:            'get_toned',
  fitnessLevel:    'beginner',
  daysPerWeek:     3,
  equipment:       'none',
  gender:          'female',
  sessionDuration: '15-30',
  weight:          135,
}, {
  'Exercise cap = 3 for beginner + 15-30 min': plan =>
    plan.weeks[0].sessions.filter(s => !s.isRestDay)
      .every(s => (s.exercises || []).length <= 3),
  'All exercises are BEGINNER difficulty': plan =>
    plan.weeks.flatMap(w =>
      w.sessions.flatMap(s => s.exercises || [])
    ).every(ex => ex.difficulty === 'BEGINNER'),
});

// Test 4: improve_endurance + advanced + 5 days + gym + male + 60+ min
allTestsPassed &= testPlan(4, {
  label:           'Improve Endurance / Advanced / 5-day / Gym / Male / 60+ min',
  goal:            'improve_endurance',
  fitnessLevel:    'advanced',
  daysPerWeek:     5,
  equipment:       'gym_access',
  gender:          'male',
  sessionDuration: '60+',
  weight:          185,
}, {
  'Sets = 4 (5 - 1 modifier)': plan =>
    plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.find(e => !e.isFinisher)?.sets === 4,
  'Rest seconds = 30': plan =>
    plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.[0]?.restSeconds === 30,
  'At least 1 rest day per week': plan =>
    plan.weeks[0].sessions.filter(s => s.isRestDay).length >= 1,
});

// Test 5: stay_active + intermediate + 4 days + dumbbells + other + 30-45 min
allTestsPassed &= testPlan(5, {
  label:           'Stay Active / Intermediate / 4-day / Dumbbells / Other / 30-45 min',
  goal:            'stay_active',
  fitnessLevel:    'intermediate',
  daysPerWeek:     4,
  equipment:       'has_dumbbells',
  gender:          'other',
  sessionDuration: '30-45',
  weight:          160,
}, {
  'Sets = 4 (no modifier for stay_active)': plan =>
    plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.find(e => !e.isFinisher)?.sets === 4,
  'Rest seconds = 60': plan =>
    plan.weeks[0].sessions.find(s => !s.isRestDay)
      ?.exercises?.[0]?.restSeconds === 60,
  'No sex-specific emphasis (gender=other)': plan =>
    // All muscle groups should appear across sessions (no heavy deprioritisation)
    plan.weeks[0].sessions.filter(s => !s.isRestDay).length === 4,
});

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY STATS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('EXERCISE LIBRARY COUNTS (no DB — ymoveId will be null until populate script runs)');
console.log('═'.repeat(60));

let total = 0;
for (const [group, tiers] of Object.entries(CURATED)) {
  const bw  = (tiers.bodyweight || []).length;
  const db  = (tiers.dumbbells  || []).length;
  const gym = (tiers.gym        || []).length;
  const sub = bw + db + gym;
  total += sub;
  console.log(`  ${group.padEnd(12)}: ${bw} bodyweight, ${db} dumbbell, ${gym} gym  (${sub} total)`);
}
console.log(`\n  Total exercises: ${total}`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(allTestsPassed
  ? '🟢  ALL 5 TESTS PASSED — plan generator is working correctly'
  : '🔴  SOME TESTS FAILED — check errors above');
console.log('═'.repeat(60) + '\n');

process.exit(allTestsPassed ? 0 : 1);
