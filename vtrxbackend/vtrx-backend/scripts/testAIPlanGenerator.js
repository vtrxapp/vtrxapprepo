// scripts/testAIPlanGenerator.js
// Runs the AI plan generator with test profiles and prints the JSON output.
// If OPENAI_API_KEY is not set, falls back to MOCK mode (deterministic output
// built directly from the library — same format, no API call).
//
// Usage:
//   OPENAI_API_KEY=sk-... node scripts/testAIPlanGenerator.js      # real AI
//   node scripts/testAIPlanGenerator.js                             # mock mode

require('dotenv').config();

const EXERCISES       = require('../data/exerciseLibraryData');
const { validatePlan } = require('../data/planGenerator');

// ── Test profile: Test 1 ──────────────────────────────────────────────────────
const TEST_USERS = {
  1: {
    label:       'Test 1 — Beginner, bodyweight, 3 days/week',
    id:          'test-user-1',
    name:        'Alex',
    fitnessLevel: 'Beginner',
    goal:        'General Fitness',
    daysPerWeek: 3,
    equipment:   [],        // no equipment
    location:    'Home',
    weight:      165,
  },
  2: {
    label:       'Test 2 — Intermediate, dumbbells, 4 days/week',
    id:          'test-user-2',
    name:        'Jordan',
    fitnessLevel: 'Intermediate',
    goal:        'Build Muscle',
    daysPerWeek: 4,
    equipment:   ['Dumbbells'],
    location:    'Home',
    weight:      180,
  },
  3: {
    label:       'Test 3 — Intermediate, full gym, 5 days/week',
    id:          'test-user-3',
    name:        'Sam',
    fitnessLevel: 'Intermediate',
    goal:        'Build Muscle',
    daysPerWeek: 5,
    equipment:   ['Barbell', 'Dumbbells', 'Cable Machine'],
    location:    'Full Gym',
    weight:      175,
  },
};

// ── Mock plan generator (no OpenAI call) ──────────────────────────────────────
function getAllowedEquipment(user) {
  const equip  = (user.equipment || []).map(e => e.toLowerCase());
  const loc    = (user.location || '').toLowerCase();
  const hasGym = loc.includes('gym') || equip.some(e => /gym|cable|machine|barbell/.test(e));
  const hasDumbs = hasGym || equip.some(e => /dumbbell/.test(e));
  const allowed  = ['bodyweight'];
  if (hasDumbs) allowed.push('dumbbell');
  if (hasGym)   allowed.push('barbell', 'cable', 'machine');
  return allowed;
}

function setsForWeek(level, weekNum) {
  const base = level === 'advanced' ? 5 : level === 'intermediate' ? 4 : 3;
  if (weekNum === 3) return base + 1;
  if (weekNum === 4) return Math.max(2, base - 1);
  return base;
}

function buildExercise(lib, sets, restSeconds = 60) {
  return {
    libraryId:       lib.id,
    name:            lib.name,
    muscleGroup:     lib.muscleGroup,
    equipment:       lib.equipment,
    sets,
    restSeconds,
    isCompound:      lib.isCompound,
    isTimedExercise: lib.isTimed,
    durationSecs:    lib.isTimed ? (lib.defaultSecs || 30) : null,
    reps:            lib.isTimed ? null : (lib.defaultReps || 10),
    videoUrl:        lib.videoUrl || '',
  };
}

function pickByIds(ids, byId, sets) {
  return ids.map(id => {
    const lib = byId.get(id);
    if (!lib) { console.warn(`  ⚠️  ID not found in library: ${id}`); return null; }
    return buildExercise(lib, sets);
  }).filter(Boolean);
}

function generateMockPlan(user) {
  const level        = (user.fitnessLevel || 'beginner').toLowerCase();
  const allowed      = getAllowedEquipment(user);
  const daysPerWeek  = parseInt(user.daysPerWeek) || 3;
  const byId         = new Map(EXERCISES.map(e => [e.id, e]));

  // Pick the suffix that matches the user's best equipment
  const suffix = allowed.includes('barbell') ? 'GYM'
               : allowed.includes('dumbbell') ? 'DUMBBELLS'
               : 'NONE';

  // Session templates (movement key → library ID)
  const SESSIONS = {
    FULL_BODY_A: {
      name: 'Full Body A',
      ids: [`SQUAT_${suffix}`, `BENCH_${suffix}`, `LAT_PULLDOWN_${suffix}`, `SHOULDER_PRESS_${suffix}`, `PLANK_${suffix}`, `CRUNCHES_${suffix}`],
    },
    FULL_BODY_B: {
      name: 'Full Body B',
      ids: [`RDL_${suffix}`, `LUNGE_${suffix}`, `ROW_${suffix}`, `BICEP_CURL_${suffix}`, `TRICEP_PUSHDOWN_${suffix}`, `CALF_RAISE_${suffix}`],
    },
    UPPER: {
      name: 'Upper Body',
      ids: [`BENCH_${suffix}`, `SHOULDER_PRESS_${suffix}`, `LAT_PULLDOWN_${suffix}`, `ROW_${suffix}`, `BICEP_CURL_${suffix}`, `TRICEP_PUSHDOWN_${suffix}`],
    },
    LOWER: {
      name: 'Lower Body',
      ids: [`SQUAT_${suffix}`, `RDL_${suffix}`, `LUNGE_${suffix}`, `CALF_RAISE_${suffix}`, `PLANK_${suffix}`, `CRUNCHES_${suffix}`],
    },
    PUSH: {
      name: 'Push',
      ids: [`BENCH_${suffix}`, `INCLINE_PRESS_${suffix}`, `SHOULDER_PRESS_${suffix}`, `LATERAL_RAISE_${suffix}`, `TRICEP_PUSHDOWN_${suffix}`, `PLANK_${suffix}`],
    },
    PULL: {
      name: 'Pull',
      ids: [`LAT_PULLDOWN_${suffix}`, `ROW_${suffix}`, `FACE_PULL_${suffix}`, `BICEP_CURL_${suffix}`, `SUPERMAN_${suffix}`, `CRUNCHES_${suffix}`],
    },
    LEGS: {
      name: 'Legs',
      ids: [`SQUAT_${suffix}`, `RDL_${suffix}`, `LUNGE_${suffix}`, `CALF_RAISE_${suffix}`, `PLANK_${suffix}`, `CRUNCHES_${suffix}`],
    },
    REST: { name: 'Rest Day', ids: [] },
  };

  const SCHEDULES = {
    3: [['Monday','FULL_BODY_A'],['Tuesday','REST'],['Wednesday','FULL_BODY_B'],['Thursday','REST'],['Friday','FULL_BODY_A'],['Saturday','REST'],['Sunday','REST']],
    4: [['Monday','UPPER'],['Tuesday','LOWER'],['Wednesday','REST'],['Thursday','UPPER'],['Friday','LOWER'],['Saturday','REST'],['Sunday','REST']],
    5: [['Monday','PUSH'],['Tuesday','PULL'],['Wednesday','LEGS'],['Thursday','PUSH'],['Friday','PULL'],['Saturday','REST'],['Sunday','REST']],
  };

  const schedule = SCHEDULES[daysPerWeek] || SCHEDULES[3];
  const goal = user.goal || 'General Fitness';
  const restSecs = /muscle|strength/i.test(goal) ? 90 : 60;

  const weeks = [];
  for (let w = 1; w <= 4; w++) {
    const sets = setsForWeek(level, w);
    const sessions = schedule.map(([dayOfWeek, key]) => {
      const tpl = SESSIONS[key];
      if (key === 'REST') {
        return { dayOfWeek, sessionName: 'Rest Day', isRestDay: true, durationMins: 0, exercises: [] };
      }
      return {
        dayOfWeek,
        sessionName:  tpl.name,
        isRestDay:    false,
        durationMins: 45,
        exercises:    pickByIds(tpl.ids, byId, sets).map(ex => ({ ...ex, restSeconds: restSecs })),
      };
    });
    weeks.push({ weekNumber: w, sessions });
  }

  const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
  return {
    planName:   `${levelLabel} ${goal} — ${daysPerWeek}×/week (MOCK)`,
    frequency:  daysPerWeek,
    level,
    totalWeeks: 4,
    weeks,
  };
}

// ── Run ────────────────────────────────────────────────────────────────────────
async function run() {
  const testNum  = parseInt(process.argv[2]) || 1;
  const user     = TEST_USERS[testNum];
  const useMock  = !process.env.OPENAI_API_KEY;

  if (!user) {
    console.error(`Unknown test number. Use 1, 2, or 3.`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${user.label}`);
  console.log(`Mode: ${useMock ? 'MOCK (no OPENAI_API_KEY)' : 'REAL AI (gpt-4o-mini)'}`);
  console.log(`${'='.repeat(60)}\n`);

  let plan;

  if (useMock) {
    plan = generateMockPlan(user);
    console.log('⚡ Mock plan generated (deterministic — set OPENAI_API_KEY for real AI output)\n');
  } else {
    console.log('🤖 Calling OpenAI gpt-4o-mini…\n');
    const { generateAIPlan } = require('../services/aiPlanGenerator');
    plan = await generateAIPlan(user, EXERCISES);
    console.log('✅ AI plan received\n');
  }

  // Validate
  const { valid, errors, totalExercises } = validatePlan(plan);
  if (!valid) {
    console.error('❌ VALIDATION FAILED:');
    errors.forEach(e => console.error('  •', e));
    process.exit(1);
  }
  console.log(`✅ Validation passed — ${totalExercises} total exercises across 4 weeks\n`);

  // Print summary
  console.log(`Plan: ${plan.planName}`);
  console.log(`Level: ${plan.level}  |  Frequency: ${plan.frequency}×/week  |  Weeks: ${plan.totalWeeks}\n`);

  // Week 1 detail
  const week1 = plan.weeks[0];
  console.log('── Week 1 Sessions ──────────────────────────────────────');
  for (const session of week1.sessions) {
    if (session.isRestDay) {
      console.log(`  ${session.dayOfWeek.padEnd(12)} REST`);
      continue;
    }
    console.log(`  ${session.dayOfWeek.padEnd(12)} ${session.sessionName} (${session.durationMins} min)`);
    for (const ex of session.exercises) {
      const detail = ex.isTimedExercise
        ? `${ex.sets}×${ex.durationSecs}s`
        : `${ex.sets}×${ex.reps}`;
      const video = ex.videoUrl ? '🎥' : '(no video yet)';
      console.log(`    • [${ex.libraryId.padEnd(24)}] ${ex.name.padEnd(30)} ${detail.padEnd(8)} ${video}`);
    }
  }

  // Full JSON
  console.log('\n── Full Plan JSON ───────────────────────────────────────');
  console.log(JSON.stringify(plan, null, 2));
}

run().catch(err => { console.error(err); process.exit(1); });
