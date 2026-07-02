// ─────────────────────────────────────────────────────────────────────────────
// scripts/fixMismatchedExerciseVideos.js — Clear stale/incorrect video matches
//
// getExerciseVideoUrl's name-based ymove lookup used to strip spaces before
// comparing names, so short queries like "Plank" could match compound-name
// ymove variants like "Plank Jack" (a jumping exercise, not a static hold) —
// and that WRONG ymoveId then got permanently back-filled onto the Exercise
// row, so every future request served the same wrong video via the fast path.
//
// The matching algorithm is now fixed (word-based, rejects variant-modifier
// words like jack/jump/burpee unless we asked for them), but that fix only
// applies to *new* lookups. This one-off script clears the cached ymoveId +
// thumbnailUrl for every exercise name currently used by the plan generator,
// so each one gets freshly re-matched with the corrected logic on next view.
//
// Run once, against the production DATABASE_URL:
//   node scripts/fixMismatchedExerciseVideos.js
// Safe to re-run — it only clears fields, never deletes rows.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Every exercise name in the current MVP bank (data/exerciseLibrary.js)
const EXERCISE_NAMES = [
  'Barbell Bench Press', 'Dumbbell Chest Press', 'Push-Up',
  'Overhead Press', 'Dumbbell Shoulder Press', 'Pike Push-Up',
  'Cable Tricep Pushdown', 'Dumbbell Overhead Extension', 'Diamond Push-Up',
  'Incline Barbell Press', 'Incline Dumbbell Press', 'Decline Push-Up',
  'Cable Lateral Raise', 'Dumbbell Lateral Raise', 'Plank Shoulder Taps',
  'Lat Pulldown', 'Dumbbell Pullover', 'Pull-Up',
  'Seated Cable Row', 'Dumbbell Row', 'Inverted Row',
  'EZ Bar Curl', 'Dumbbell Bicep Curl', 'Isometric Curl',
  'Cable Face Pull', 'Dumbbell Rear Delt Fly', 'Prone Y-Raise',
  'Back Extension', 'Superman Hold',
  'Barbell Squat', 'Goblet Squat', 'Air Squat',
  'Barbell Romanian Deadlift', 'Dumbbell RDL', 'Single-Leg RDL',
  'Barbell Lunge', 'Dumbbell Lunge', 'Walking Lunge',
  'Machine Calf Raise', 'Standing Calf Raise', 'Calf Raise',
  'Plank', 'Crunches',
];

async function main() {
  console.log(`Checking ${EXERCISE_NAMES.length} exercise names for cached ymoveId...`);
  let cleared = 0;

  for (const name of EXERCISE_NAMES) {
    const rows = await prisma.exercise.findMany({
      where: { name: { equals: name, mode: 'insensitive' }, ymoveId: { not: null } },
    });
    for (const row of rows) {
      await prisma.exercise.update({
        where: { id: row.id },
        data:  { ymoveId: null, thumbnailUrl: null },
      });
      console.log(`  cleared "${row.name}" (was ymoveId=${row.ymoveId})`);
      cleared++;
    }
  }

  console.log(`\nDone — ${cleared} exercise(s) cleared and will be freshly re-matched on next view.`);
}

const run = () => main().finally(() => prisma.$disconnect());
module.exports = { run };

if (require.main === module) {
  run().catch(e => { console.error(e); process.exit(1); });
}
