// ─────────────────────────────────────────────────────────────────────────────
// scripts/populateExerciseLibrary.js
//
// Fetches exercises from the ymove API for every muscle group in the curated
// library, matches them by name, and upserts ymove IDs + thumbnail URLs into
// the exercises table.
//
// Run on Railway (where YMOVE_API_KEY is set):
//   node scripts/populateExerciseLibrary.js
//
// Safe to re-run — uses upsert so nothing is duplicated.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const ymove = require('../services/ymoveService');
const { CURATED, getAllExercises, invalidateCache } = require('../data/exerciseLibrary');

const prisma = new PrismaClient();

// Normalise name for fuzzy matching
const norm = name => name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Score two names for similarity (0 = no match, 1 = exact)
function nameSimilarity(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  // Word overlap score
  const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '));
  const intersection = [...wa].filter(w => wb.has(w)).length;
  return intersection / Math.max(wa.size, wb.size);
}

async function main() {
  if (!process.env.YMOVE_API_KEY) {
    console.error('❌  YMOVE_API_KEY not set. Cannot fetch from ymove.');
    process.exit(1);
  }

  console.log('🏋️  Populating exercise library from ymove…\n');

  // Collect all curated exercise specs (flat list)
  const allCurated = getAllExercises(CURATED);

  // Unique muscle groups to query
  const muscleGroupsToFetch = [
    'chest', 'back', 'shoulders', 'biceps', 'triceps',
    'legs', 'glutes', 'core', 'cardio', 'full body',
    // ymove may use these aliases:
    'arms', 'abs', 'calves', 'hamstrings', 'quadriceps',
  ];

  // Fetch ymove exercises for every group (build a flat pool)
  const ymovePool = [];
  for (const group of muscleGroupsToFetch) {
    process.stdout.write(`  Fetching ${group.padEnd(15)} from ymove… `);
    const { exercises } = await ymove.getExercises({ muscleGroup: group, limit: 50, hasVideo: true });
    ymovePool.push(...exercises);
    console.log(`${exercises.length} exercises`);
    await delay(300);
  }

  // Deduplicate by ymove ID
  const seenIds = new Set();
  const uniquePool = ymovePool.filter(ex => {
    const id = String(ex.id || ex.ymove_id || '');
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  console.log(`\n  ymove pool: ${uniquePool.length} unique exercises\n`);

  let matched   = 0;
  let unmatched = 0;

  for (const spec of allCurated) {
    // Find the best ymove match by name similarity
    let best = null;
    let bestScore = 0;

    for (const ex of uniquePool) {
      const score = nameSimilarity(spec.name, ex.name || ex.title || '');
      if (score > bestScore) { best = ex; bestScore = score; }
    }

    if (!best || bestScore < 0.7) {
      console.log(`  ⚠️  No match for "${spec.name}" (best score: ${bestScore.toFixed(2)})`);
      unmatched++;
      continue;
    }

    const ymoveId    = String(best.id || best.ymove_id);
    const videoUrl   = best.video_url   || best.videoUrl   || null;
    const thumbnail  = best.thumbnail_url || best.thumbnailUrl || best.gif_url || null;
    const equipment  = best.equipment   || best.equipment_type || null;

    // Upsert into exercises table
    await prisma.exercise.upsert({
      where:  { ymoveId },
      update: { thumbnailUrl: thumbnail },
      create: {
        name:        spec.name,
        muscleGroup: spec.muscleGroup,
        equipment:   equipment || null,
        ymoveId,
        videoUrl:    videoUrl  || null,
        thumbnailUrl: thumbnail || null,
      },
    });

    console.log(`  ✓  "${spec.name}" → ymove ID ${ymoveId} (score ${bestScore.toFixed(2)})`);
    matched++;
    await delay(100);
  }

  // Invalidate in-memory cache so next plan generation picks up new IDs
  invalidateCache();

  console.log(`\n✅  Done.`);
  console.log(`   Matched:   ${matched}`);
  console.log(`   Unmatched: ${unmatched}`);
  if (unmatched > 0) {
    console.log(`   ⚠️  Run again or manually add unmatched exercises to the DB.`);
  }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

main()
  .catch(err => { console.error('\n❌  Failed:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
