#!/usr/bin/env node
// scripts/fetchExerciseLibrary.js
// Fetches machine, dumbbell, and bodyweight exercises from ymove API,
// validates video URLs, and exports vtrx_exercise_library.csv
//
// Usage:
//   YMOVE_API_KEY=<key> node scripts/fetchExerciseLibrary.js
//   Output: vtrx_exercise_library.csv (in current directory)

'use strict';

const axios  = require('axios');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const API_KEY  = process.env.YMOVE_API_KEY;
const BASE_URL = process.env.YMOVE_API_URL || 'https://exercise-api.ymove.app/api/v2';

if (!API_KEY) {
  console.error('ERROR: YMOVE_API_KEY env var not set.');
  console.error('Usage: YMOVE_API_KEY=<key> node scripts/fetchExerciseLibrary.js');
  process.exit(1);
}

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
});

const MUSCLE_GROUPS = ['chest','back','legs','shoulders','biceps','triceps','core','glutes'];

// ─── keyword matchers ───────────────────────────────────────────────────────
const MACHINE_KEYWORDS = [
  'machine','cable','pulldown','lat pulldown','leg press','leg extension',
  'leg curl','pec deck','seated row','smith machine','hip abductor',
  'hip adductor','chest press','row machine','shoulder press machine',
  'ab machine','crunch machine','assisted',
];
const DUMBBELL_KEYWORDS = ['dumbbell','dumbell',' db ','(db)'];
const BODYWEIGHT_KEYWORDS = [
  'push up','pushup','push-up','squat bodyweight','plank','lunge','crunch',
  'sit up','sit-up','mountain climber','burpee','jump','glute bridge',
  'hip thrust bodyweight',
];

const matchesAny = (name, keywords) => {
  const lower = name.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
};

// ─── preferred dumbbell exercises per muscle group ──────────────────────────
const DB_PRIORITY = {
  chest:     ['db bench press','db fly','incline db press','db pullover'],
  back:      ['db row','single arm db row','db pullover','bent over db row'],
  legs:      ['db squat','db lunge','db romanian deadlift','db step up','db sumo squat'],
  shoulders: ['db shoulder press','db lateral raise','db front raise','db arnold press'],
  biceps:    ['db curl','db hammer curl','db concentration curl','alternating db curl'],
  triceps:   ['db tricep extension','db overhead extension','db kickback','db skull crusher'],
  core:      ['db russian twist','db woodchop','db side bend'],
  glutes:    ['db hip thrust','db glute bridge','db romanian deadlift'],
};

// ─── cross-group sanity check ───────────────────────────────────────────────
// muscles that strongly suggest wrong group
const WRONG_GROUP = {
  chest:     ['leg curl','leg extension','leg press','squat','hamstring','hip'],
  back:      ['chest','pec','fly','bench'],
  legs:      ['tricep','bicep','shoulder press','lateral raise'],
  shoulders: ['leg','squat','lunge','crunch'],
  biceps:    ['squat','lunge','leg','chest press','pec'],
  triceps:   ['squat','lunge','leg','curl'],
  core:      ['bench press','squat','deadlift'],
  glutes:    ['bicep curl','tricep','shoulder press'],
};

function sanityCheck(name, muscleGroup) {
  const lower = name.toLowerCase();
  const bad   = WRONG_GROUP[muscleGroup] || [];
  return !bad.some(kw => lower.includes(kw));
}

// ─── fetch all exercises for a muscle group ─────────────────────────────────
async function fetchGroup(muscleGroup) {
  try {
    const { data } = await api.get('/exercises', {
      params: { muscleGroup, pageSize: 50, page: 1 },
    });
    const list = Array.isArray(data) ? data : (data?.data || data?.exercises || data?.items || []);
    console.log(`  ${muscleGroup}: ${list.length} exercises returned`);
    return list;
  } catch (err) {
    console.error(`  ${muscleGroup}: fetch failed — ${err.response?.status || err.message}`);
    return [];
  }
}

// ─── validate a video URL with HEAD request ──────────────────────────────────
function headRequest(url) {
  return new Promise(resolve => {
    try {
      const lib    = url.startsWith('https') ? https : http;
      const parsed = new URL(url);
      const req    = lib.request({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD', timeout: 8000 }, res => {
        resolve(res.statusCode);
      });
      req.on('error',   () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.end();
    } catch {
      resolve(0);
    }
  });
}

// ─── normalise exercise shape from API response ──────────────────────────────
function normalise(ex, muscleGroup) {
  const id       = ex.id || ex.ymoveId || ex.exercise_id || null;
  const name     = ex.name || ex.title || ex.exerciseName || '';
  const videoUrl = ex.videoUrl || ex.video_url
    || (Array.isArray(ex.videos) ? (ex.videos.find(v => v.isPrimary) || ex.videos[0])?.videoUrl : null)
    || null;
  const thumbUrl = ex.thumbnailUrl || ex.thumbnail_url || ex.imageUrl || null;
  const equip    = (ex.equipment || ex.equipmentType || '').toLowerCase();
  const diff     = (ex.difficulty || 'beginner').toLowerCase();
  return { id, name, muscleGroup, videoUrl, thumbUrl, equip, diff, raw: ex };
}

// ─── determine equipment bucket ──────────────────────────────────────────────
function equipBucket(name, equip) {
  const n = name.toLowerCase();
  const e = (equip || '').toLowerCase();
  if (matchesAny(n, MACHINE_KEYWORDS) || e.includes('machine') || e.includes('cable')) return 'machine';
  if (matchesAny(n, DUMBBELL_KEYWORDS) || e.includes('dumbbell') || e.includes('db'))  return 'dumbbell';
  if (matchesAny(n, BODYWEIGHT_KEYWORDS) || e === '' || e === 'none' || e === 'bodyweight') return 'bodyweight';
  return null;
}

// ─── is_compound heuristic ───────────────────────────────────────────────────
const COMPOUND_WORDS = ['press','row','squat','deadlift','lunge','pull','push up','pulldown','dip','clean','thrust'];
function isCompound(name) {
  const n = name.toLowerCase();
  return COMPOUND_WORDS.some(w => n.includes(w));
}

// ─── is_timed heuristic ─────────────────────────────────────────────────────
const TIMED_WORDS = ['plank','hold','isometric','wall sit'];
function isTimed(name) {
  return TIMED_WORDS.some(w => name.toLowerCase().includes(w));
}

// ─── difficulty normalise ────────────────────────────────────────────────────
function normDiff(diff, bucket) {
  if (diff === 'advanced') return 'ADVANCED';
  if (diff === 'intermediate') return 'INTERMEDIATE';
  if (bucket === 'machine' || bucket === 'bodyweight') return 'BEGINNER';
  if (bucket === 'dumbbell') return 'INTERMEDIATE';
  return 'BEGINNER';
}

// ─── sort dumbbell candidates by priority list ───────────────────────────────
function sortByPriority(exercises, muscleGroup) {
  const prio = (DB_PRIORITY[muscleGroup] || []).map(s => s.toLowerCase());
  return [...exercises].sort((a, b) => {
    const ai = prio.findIndex(p => a.name.toLowerCase().includes(p));
    const bi = prio.findIndex(p => b.name.toLowerCase().includes(p));
    const ar = ai === -1 ? 999 : ai;
    const br = bi === -1 ? 999 : bi;
    return ar - br;
  });
}

// ─── build CSV row ───────────────────────────────────────────────────────────
function csvRow(ex) {
  const timed     = isTimed(ex.name);
  const compound  = isCompound(ex.name);
  const defReps   = timed ? 0 : compound ? 10 : 12;
  const defSecs   = timed ? 30 : 0;
  const diff      = normDiff(ex.diff, ex.bucket);
  const note      = ex.note || '';
  const cols = [
    ex.id, ex.name, ex.muscleGroup, ex.bucket, diff,
    ex.videoUrl || '', ex.thumbUrl || '',
    compound ? 'true' : 'false',
    timed    ? 'true' : 'false',
    defReps, defSecs, note,
  ];
  return cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',');
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== VTRX Exercise Library Fetcher ===`);
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`API Key  : ${API_KEY.slice(0,8)}...\n`);

  const allByGroup = {};

  // STEP 1-3: Fetch all groups
  console.log('── Fetching from ymove API ──');
  for (const mg of MUSCLE_GROUPS) {
    const raw = await fetchGroup(mg);
    allByGroup[mg] = raw.map(ex => normalise(ex, mg));
    await new Promise(r => setTimeout(r, 300)); // gentle rate-limit spacing
  }

  // STEP 1-3: Filter into buckets
  const kept    = [];
  const removed = [];

  const machineByGroup    = {};
  const dumbbellByGroup   = {};
  const bodyweightByGroup = {};

  for (const mg of MUSCLE_GROUPS) {
    const exercises = allByGroup[mg] || [];

    // ── machines (max 5) ──
    const machines = exercises
      .filter(ex => {
        const b = equipBucket(ex.name, ex.equip);
        return b === 'machine';
      })
      .slice(0, 5)
      .map(ex => ({ ...ex, bucket: 'machine' }));
    machineByGroup[mg] = machines;

    // ── dumbbells (max 5, priority sorted) ──
    const dbCandidates = exercises.filter(ex => {
      const b = equipBucket(ex.name, ex.equip);
      return b === 'dumbbell';
    });
    const dbSorted = sortByPriority(dbCandidates, mg).slice(0, 5).map(ex => ({ ...ex, bucket: 'dumbbell' }));
    dumbbellByGroup[mg] = dbSorted;

    // ── bodyweight (max 3) ──
    const bwCandidates = exercises.filter(ex => {
      const n = ex.name.toLowerCase();
      return BODYWEIGHT_KEYWORDS.some(kw => n.includes(kw));
    });
    bodyweightByGroup[mg] = bwCandidates.slice(0, 3).map(ex => ({ ...ex, bucket: 'bodyweight' }));
  }

  // STEP 4: Collect all candidates and validate
  const candidates = [];
  for (const mg of MUSCLE_GROUPS) {
    candidates.push(...(machineByGroup[mg]    || []));
    candidates.push(...(dumbbellByGroup[mg]   || []));
    candidates.push(...(bodyweightByGroup[mg] || []));
  }

  console.log(`\n── Validating ${candidates.length} candidate exercises ──`);
  let validated = 0;

  for (const ex of candidates) {
    // 1. Check ID
    if (!ex.id) {
      removed.push({ name: ex.name, mg: ex.muscleGroup, reason: 'No ymove ID' });
      continue;
    }
    // 2. Sanity check muscle group vs name
    if (!sanityCheck(ex.name, ex.muscleGroup)) {
      removed.push({ name: ex.name, mg: ex.muscleGroup, reason: `Name does not match muscle group "${ex.muscleGroup}"` });
      continue;
    }
    // 3. Video URL present
    if (!ex.videoUrl) {
      removed.push({ name: ex.name, mg: ex.muscleGroup, reason: 'No videoUrl' });
      continue;
    }
    // 4. HEAD check video URL
    process.stdout.write(`  Checking ${ex.name.slice(0,40).padEnd(40)} ... `);
    const status = await headRequest(ex.videoUrl);
    if (status === 200 || status === 206 || status === 302 || status === 301) {
      process.stdout.write(`${status} OK\n`);
      kept.push(ex);
      validated++;
    } else {
      process.stdout.write(`${status || 'ERR'} REMOVED\n`);
      removed.push({ name: ex.name, mg: ex.muscleGroup, reason: `Video HEAD returned ${status || 'network error'}` });
    }
  }

  // STEP 5: Write CSV
  const CSV_HEADER = 'ymove_id,name,muscle_group,equipment,difficulty,video_url,thumbnail_url,is_compound,is_timed,default_reps,default_duration_secs,notes';
  const csvLines   = [CSV_HEADER, ...kept.map(csvRow)];
  const csvPath    = path.join(process.cwd(), 'vtrx_exercise_library.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
  console.log(`\n── CSV written: ${csvPath} (${kept.length} rows) ──`);

  // STEP 6: Summary
  console.log('\n════════════════════════════════════════');
  console.log('MACHINE EXERCISES FOUND:');
  let totalMachine = 0;
  for (const mg of MUSCLE_GROUPS) {
    const ex = kept.filter(e => e.muscleGroup === mg && e.bucket === 'machine');
    console.log(`  ${mg.padEnd(12)}: ${ex.length}  ${ex.map(e=>e.name).join(' | ')}`);
    totalMachine += ex.length;
  }
  console.log(`  Total machines: ${totalMachine}`);

  console.log('\nDUMBBELL EXERCISES FOUND:');
  let totalDB = 0;
  for (const mg of MUSCLE_GROUPS) {
    const ex = kept.filter(e => e.muscleGroup === mg && e.bucket === 'dumbbell');
    console.log(`  ${mg.padEnd(12)}: ${ex.length}  ${ex.map(e=>e.name).join(' | ')}`);
    totalDB += ex.length;
  }
  console.log(`  Total dumbbells: ${totalDB}`);

  console.log('\nBODYWEIGHT EXERCISES FOUND:');
  const bwAll = kept.filter(e => e.bucket === 'bodyweight');
  console.log(`  Total bodyweight: ${bwAll.length}`);

  console.log('\nREMOVED (failed validation):');
  console.log(`  ${removed.length} exercises removed`);
  for (const r of removed) {
    console.log(`  ✗ [${r.mg}] ${r.name} — ${r.reason}`);
  }

  console.log(`\nTOTAL EXERCISES IN LIBRARY: ${kept.length}`);
  console.log('════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
