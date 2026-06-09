// ─────────────────────────────────────────────────────────────────────────────
// scripts/seedExercises.js — Seed exercise library from ymove.app
// ─────────────────────────────────────────────────────────────────────────────
// Run: node scripts/seedExercises.js
// Requires: DATABASE_URL and YMOVE_API_KEY in environment
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const ymove = require('../services/ymoveService');

const prisma = new PrismaClient();

// ── Normalise exercise fields — ymove may use different casing ────────────────
const normalise = (ex) => ({
  ymoveId:      String(ex.id        || ex.ymove_id   || ''),
  name:         ex.name             || ex.title       || 'Unknown Exercise',
  muscleGroup:  ex.muscle_group     || ex.muscleGroup || ex.target || 'Full Body',
  equipment:    ex.equipment        || ex.equipment_type || null,
  instructions: ex.instructions     || ex.description || null,
  videoUrl:     ex.video_url        || ex.videoUrl    || null,
  thumbnailUrl: ex.thumbnail_url    || ex.thumbnailUrl || ex.gif_url || null,
});

// ── Workout templates to create ───────────────────────────────────────────────
const TEMPLATES = [
  {
    name: 'Chest & Triceps',       type: 'STRENGTH', duration: 45, calories: 320,
    difficulty: 'Intermediate',    muscleGroups: ['chest', 'arms'],
  },
  {
    name: 'Back & Biceps',         type: 'STRENGTH', duration: 45, calories: 300,
    difficulty: 'Intermediate',    muscleGroups: ['back', 'arms'],
  },
  {
    name: 'Legs & Core',           type: 'STRENGTH', duration: 50, calories: 380,
    difficulty: 'Intermediate',    muscleGroups: ['legs', 'core'],
  },
  {
    name: 'Shoulder & Arms',       type: 'STRENGTH', duration: 40, calories: 290,
    difficulty: 'Intermediate',    muscleGroups: ['shoulders', 'arms'],
  },
  {
    name: 'HIIT Full Body',        type: 'HIIT',     duration: 30, calories: 420,
    difficulty: 'Intermediate',    muscleGroups: ['legs', 'core', 'chest'],
  },
  {
    name: 'Full Body Strength',    type: 'STRENGTH', duration: 55, calories: 400,
    difficulty: 'Intermediate',    muscleGroups: ['chest', 'back', 'legs'],
  },
  {
    name: 'Active Recovery Flow',  type: 'RECOVERY', duration: 20, calories: 100,
    difficulty: 'Beginner',        muscleGroups: ['core'],
  },
];

// ── Main seed ─────────────────────────────────────────────────────────────────
async function seed() {
  if (!process.env.YMOVE_API_KEY) {
    console.error('❌  YMOVE_API_KEY is not set. Add it to your .env file first.');
    process.exit(1);
  }

  console.log('🌱  Seeding exercise library from ymove.app…\n');

  const muscleGroups = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core'];
  const byGroup = {};

  // ── 1. Fetch exercises from ymove ─────────────────────────────────────────
  for (const group of muscleGroups) {
    process.stdout.write(`  Fetching ${group.padEnd(12)}…`);
    const result = await ymove.getExercises({ muscleGroup: group, limit: 12 });
    byGroup[group] = (result.exercises || []).map(normalise).filter(e => e.ymoveId);
    console.log(` ${byGroup[group].length} exercises`);
    await delay(300); // be kind to the API
  }

  // ── 2. Upsert exercises into database ─────────────────────────────────────
  console.log('\n  Upserting exercises…');
  const dbById = {}; // ymoveId → prisma Exercise

  for (const exercises of Object.values(byGroup)) {
    for (const ex of exercises) {
      const existing = await prisma.exercise.findFirst({
        where: { ymoveId: ex.ymoveId },
      });

      if (existing) {
        // Update video/thumbnail URL if available
        if ((ex.videoUrl && !existing.videoUrl) || (ex.thumbnailUrl && !existing.thumbnailUrl)) {
          await prisma.exercise.update({
            where: { id: existing.id },
            data:  { videoUrl: ex.videoUrl || existing.videoUrl, thumbnailUrl: ex.thumbnailUrl || existing.thumbnailUrl },
          });
        }
        dbById[ex.ymoveId] = existing;
      } else {
        const created = await prisma.exercise.create({
          data: {
            name:         ex.name,
            muscleGroup:  ex.muscleGroup,
            equipment:    ex.equipment,
            instructions: ex.instructions,
            videoUrl:     ex.videoUrl,
            ymoveId:      ex.ymoveId,
            thumbnailUrl: ex.thumbnailUrl,
          },
        });
        dbById[ex.ymoveId] = created;
        process.stdout.write('.');
      }
    }
  }
  console.log('\n  ✓ Exercises done\n');

  // ── 3. Create workout templates ───────────────────────────────────────────
  console.log('  Creating workout templates…');

  for (const t of TEMPLATES) {
    const exists = await prisma.workout.findFirst({ where: { name: t.name } });
    if (exists) {
      console.log(`  ↩  "${t.name}" already exists, skipping`);
      continue;
    }

    // Gather exercises for this workout (up to 3 per muscle group, max 8 total)
    const candidates = t.muscleGroups
      .flatMap(g => (byGroup[g] || []).slice(0, 3))
      .filter((ex, i, arr) => arr.findIndex(e => e.ymoveId === ex.ymoveId) === i)
      .slice(0, 8);

    const exerciseLinks = candidates
      .map((ex, i) => {
        const db = dbById[ex.ymoveId];
        if (!db) return null;
        return {
          exerciseId: db.id,
          order:      i + 1,
          sets:       t.type === 'HIIT' ? 4 : 3,
          reps:       t.type === 'HIIT' ? '45s' : '8-12',
          restSecs:   t.type === 'HIIT' ? 20 : 60,
        };
      })
      .filter(Boolean);

    const workout = await prisma.workout.create({
      data: {
        name:        t.name,
        type:        t.type,
        duration:    t.duration,
        calories:    t.calories,
        difficulty:  t.difficulty,
        isPublic:    true,
        exercises:   { create: exerciseLinks },
      },
    });

    console.log(`  ✓  "${workout.name}" — ${exerciseLinks.length} exercises`);
  }

  console.log('\n✅  Seed complete! Your exercise library is ready.');
  console.log('   Users will now see real exercises with video demos.\n');
}

const delay = ms => new Promise(r => setTimeout(r, ms));

seed()
  .catch(err => { console.error('\n❌  Seed failed:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
