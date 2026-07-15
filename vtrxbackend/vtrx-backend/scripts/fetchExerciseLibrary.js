#!/usr/bin/env node
// scripts/fetchExerciseLibrary.js
// Fetches machine, dumbbell, and bodyweight exercises from ymove API,
// validates video URLs, and exports vtrx_exercise_library.csv
//
// Uses ONLY Node.js built-ins — no npm install needed.
//
// Usage (run from any directory with Node.js installed):
//   YMOVE_API_KEY=<key> node fetchExerciseLibrary.js
//   Output: vtrx_exercise_library.csv (in the same directory)

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const API_KEY  = process.env.YMOVE_API_KEY;
const BASE     = 'exercise-api.ymove.app';
const BASE_PATH = '/api/v2';

if (!API_KEY) {
  console.error('ERROR: YMOVE_API_KEY env var not set.');
  console.error('Usage: YMOVE_API_KEY=<key> node fetchExerciseLibrary.js');
  process.exit(1);
}

// ─── minimal HTTPS GET ───────────────────────────────────────────────────────
function get(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path: pathAndQuery,
      method: 'GET',
      headers: { 'X-API-Key': API_KEY, 'Accept': 'application/json' },
      timeout: 20000,
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({}); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} — ${raw.slice(0, 120)}`));
        }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// HEAD request to validate video URL
function head(rawUrl) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(rawUrl);
      const lib    = parsed.protocol === 'https:' ? https : http;
      const req    = lib.request({
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'HEAD',
        timeout:  8000,
      }, res => resolve(res.statusCode));
      req.on('error',   () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.end();
    } catch { resolve(0); }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const toArray = r => Array.isArray(r) ? r : (r?.data || r?.exercises || r?.items || r?.results || []);

// ─── config ──────────────────────────────────────────────────────────────────
const MUSCLE_GROUPS = ['chest','back','legs','shoulders','biceps','triceps','core','glutes'];

const MACHINE_KEYWORDS = [
  'machine','cable','pulldown','lat pulldown','leg press','leg extension',
  'leg curl','pec deck','seated row','smith machine','hip abductor',
  'hip adductor','chest press','row machine','shoulder press machine',
  'ab machine','crunch machine','assisted',
];
const DUMBBELL_KEYWORDS = ['dumbbell','dumbell',' db ','(db)','db '];
const BODYWEIGHT_KEYWORDS = [
  'push up','pushup','push-up','plank','lunge','crunch','sit up','sit-up',
  'mountain climber','burpee','jump','glute bridge','hip thrust bodyweight',
  'bodyweight squat','air squat',
];

const WRONG_GROUP = {
  chest:     ['leg curl','leg extension','leg press','squat','hamstring','hip abduct','hip adduct'],
  back:      ['chest press','pec deck','fly','incline bench'],
  legs:      ['bicep curl','lateral raise','shoulder press','tricep'],
  shoulders: ['leg press','squat','lunge','crunch','ab '],
  biceps:    ['squat','lunge','leg press','leg curl','chest press','pec'],
  triceps:   ['squat','lunge','leg press','leg curl','bicep curl'],
  core:      ['bench press','leg press','squat','deadlift'],
  glutes:    ['bicep curl','lateral raise','shoulder press','tricep'],
};

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

const COMPOUND_WORDS = ['press','row','squat','deadlift','lunge','pull','push up','push-up','pulldown','dip','clean','thrust','clean'];
const TIMED_WORDS    = ['plank','hold','isometric','wall sit'];

// ─── helpers ─────────────────────────────────────────────────────────────────
const matchesAny = (name, kws) => { const n = name.toLowerCase(); return kws.some(k => n.includes(k)); };

function sanityCheck(name, mg) {
  const bad = WRONG_GROUP[mg] || [];
  return !matchesAny(name, bad);
}

function equipBucket(name, equip) {
  const n = name.toLowerCase();
  const e = (equip || '').toLowerCase();
  if (matchesAny(n, MACHINE_KEYWORDS) || e.includes('machine') || e.includes('cable')) return 'machine';
  if (matchesAny(n, DUMBBELL_KEYWORDS) || e.includes('dumbbell'))                       return 'dumbbell';
  if (matchesAny(n, BODYWEIGHT_KEYWORDS) || ['','none','bodyweight'].includes(e))        return 'bodyweight';
  return null;
}

function normalise(ex, mg) {
  const videoUrl = ex.videoUrl || ex.video_url
    || (Array.isArray(ex.videos) ? (ex.videos.find(v => v.isPrimary) || ex.videos[0])?.videoUrl : null)
    || null;
  return {
    id:       ex.id || ex.ymoveId || ex.exercise_id || null,
    name:     (ex.name || ex.title || '').trim(),
    muscleGroup: mg,
    videoUrl,
    thumbUrl: ex.thumbnailUrl || ex.thumbnail_url || ex.imageUrl || null,
    equip:    (ex.equipment || ex.equipmentType || '').toLowerCase(),
    diff:     (ex.difficulty || '').toLowerCase(),
  };
}

function sortByPriority(exercises, mg) {
  const prio = (DB_PRIORITY[mg] || []).map(s => s.toLowerCase());
  return [...exercises].sort((a, b) => {
    const ai = prio.findIndex(p => a.name.toLowerCase().includes(p));
    const bi = prio.findIndex(p => b.name.toLowerCase().includes(p));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

function normDiff(diff, bucket) {
  if (diff === 'advanced')     return 'ADVANCED';
  if (diff === 'intermediate') return 'INTERMEDIATE';
  if (bucket === 'machine' || bucket === 'bodyweight') return 'BEGINNER';
  if (bucket === 'dumbbell')   return 'INTERMEDIATE';
  return 'BEGINNER';
}

function csvRow(ex) {
  const timed    = matchesAny(ex.name, TIMED_WORDS);
  const compound = matchesAny(ex.name, COMPOUND_WORDS);
  const defReps  = timed ? 0 : compound ? 10 : 12;
  const defSecs  = timed ? 30 : 0;
  const cols = [
    ex.id, ex.name, ex.muscleGroup, ex.bucket,
    normDiff(ex.diff, ex.bucket),
    ex.videoUrl || '', ex.thumbUrl || '',
    compound ? 'true' : 'false',
    timed    ? 'true' : 'false',
    defReps, defSecs, '',
  ];
  return cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',');
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== VTRX Exercise Library Fetcher ===');
  console.log(`Base URL : https://${BASE}${BASE_PATH}`);
  console.log(`API Key  : present\n`);

  // STEP 1-3: Fetch all muscle groups
  console.log('── Fetching from ymove API ──');
  const allByGroup = {};
  for (const mg of MUSCLE_GROUPS) {
    try {
      const data = await get(`${BASE_PATH}/exercises?muscleGroup=${encodeURIComponent(mg)}&pageSize=50&page=1`);
      const list = toArray(data);
      console.log(`  ${mg.padEnd(12)}: ${list.length} exercises`);
      allByGroup[mg] = list.map(ex => normalise(ex, mg));
    } catch (err) {
      console.error(`  ${mg.padEnd(12)}: FAILED — ${err.message}`);
      allByGroup[mg] = [];
    }
    await sleep(350);
  }

  // Filter into buckets
  const machineByGroup    = {};
  const dumbbellByGroup   = {};
  const bodyweightByGroup = {};

  for (const mg of MUSCLE_GROUPS) {
    const exercises = allByGroup[mg] || [];

    machineByGroup[mg] = exercises
      .filter(ex => equipBucket(ex.name, ex.equip) === 'machine')
      .slice(0, 5)
      .map(ex => ({ ...ex, bucket: 'machine' }));

    const dbCandidates = exercises.filter(ex => equipBucket(ex.name, ex.equip) === 'dumbbell');
    dumbbellByGroup[mg] = sortByPriority(dbCandidates, mg)
      .slice(0, 5)
      .map(ex => ({ ...ex, bucket: 'dumbbell' }));

    bodyweightByGroup[mg] = exercises
      .filter(ex => matchesAny(ex.name, BODYWEIGHT_KEYWORDS))
      .slice(0, 3)
      .map(ex => ({ ...ex, bucket: 'bodyweight' }));
  }

  // Collect all candidates
  const candidates = [];
  for (const mg of MUSCLE_GROUPS) {
    candidates.push(...(machineByGroup[mg]    || []));
    candidates.push(...(dumbbellByGroup[mg]   || []));
    candidates.push(...(bodyweightByGroup[mg] || []));
  }

  // STEP 4: Validate
  console.log(`\n── Validating ${candidates.length} candidate exercises ──`);
  const kept    = [];
  const removed = [];

  for (const ex of candidates) {
    if (!ex.id) {
      removed.push({ ...ex, reason: 'No ymove ID' });
      continue;
    }
    if (!sanityCheck(ex.name, ex.muscleGroup)) {
      removed.push({ ...ex, reason: `Name mismatch for group "${ex.muscleGroup}"` });
      continue;
    }
    if (!ex.videoUrl) {
      removed.push({ ...ex, reason: 'No videoUrl' });
      continue;
    }
    process.stdout.write(`  ${ex.name.slice(0, 42).padEnd(42)} ... `);
    const status = await head(ex.videoUrl);
    if ([200, 206, 301, 302].includes(status)) {
      process.stdout.write(`${status} OK\n`);
      kept.push(ex);
    } else {
      process.stdout.write(`${status || 'ERR'} REMOVED\n`);
      removed.push({ ...ex, reason: `Video HEAD ${status || 'network error'}` });
    }
    await sleep(100);
  }

  // STEP 5: Write CSV
  const CSV_HEADER = 'ymove_id,name,muscle_group,equipment,difficulty,video_url,thumbnail_url,is_compound,is_timed,default_reps,default_duration_secs,notes';
  const csvPath    = path.join(process.cwd(), 'vtrx_exercise_library.csv');
  fs.writeFileSync(csvPath, [CSV_HEADER, ...kept.map(csvRow)].join('\n') + '\n', 'utf8');
  console.log(`\n── CSV written → ${csvPath}  (${kept.length} rows) ──`);

  // STEP 6: Summary
  console.log('\n════════════════════════════════════════');
  let totalMachine = 0, totalDB = 0;

  console.log('MACHINE EXERCISES FOUND:');
  for (const mg of MUSCLE_GROUPS) {
    const ex = kept.filter(e => e.muscleGroup === mg && e.bucket === 'machine');
    console.log(`  ${mg.padEnd(12)}: ${ex.length}  ${ex.map(e => e.name).join(' | ')}`);
    totalMachine += ex.length;
  }
  console.log(`  Total machines: ${totalMachine}`);

  console.log('\nDUMBBELL EXERCISES FOUND:');
  for (const mg of MUSCLE_GROUPS) {
    const ex = kept.filter(e => e.muscleGroup === mg && e.bucket === 'dumbbell');
    console.log(`  ${mg.padEnd(12)}: ${ex.length}  ${ex.map(e => e.name).join(' | ')}`);
    totalDB += ex.length;
  }
  console.log(`  Total dumbbells: ${totalDB}`);

  console.log('\nBODYWEIGHT EXERCISES FOUND:');
  const bwAll = kept.filter(e => e.bucket === 'bodyweight');
  console.log(`  Total bodyweight: ${bwAll.length}`);
  if (bwAll.length) console.log(`  ${bwAll.map(e => e.name).join(' | ')}`);

  console.log('\nREMOVED (failed validation):');
  console.log(`  ${removed.length} exercises removed`);
  for (const r of removed) console.log(`  ✗ [${r.muscleGroup}] ${r.name} — ${r.reason}`);

  console.log(`\nTOTAL EXERCISES IN LIBRARY: ${kept.length}`);
  console.log('════════════════════════════════════════\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
