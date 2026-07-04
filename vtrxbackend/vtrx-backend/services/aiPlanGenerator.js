// ─────────────────────────────────────────────────────────────────────────────
// services/aiPlanGenerator.js — AI-powered workout plan generator
//
// Uses Claude Haiku to build a 4-week personalised plan.
// Exercise IDs are validated against the ExerciseLibrary table — hallucinated
// IDs are replaced automatically; exercises are never silently dropped.
// ─────────────────────────────────────────────────────────────────────────────

const { getAnthropicClient } = require('./anthropicClient');
const prisma              = require('../config/database');
const logger              = require('../utils/logger');

const MIN_EXERCISES = 5;

// ── Equipment resolution ──────────────────────────────────────────────────────
function getAllowedEquipment(user) {
  const equip   = (user.equipment || []).map(e => e.toLowerCase());
  const loc     = (user.location || '').toLowerCase();
  const hasGym  = loc.includes('gym') || equip.some(e => /gym|cable|machine|barbell/.test(e));
  const hasDumbs = hasGym || equip.some(e => /dumbbell/.test(e));
  const allowed  = ['bodyweight'];
  if (hasDumbs) allowed.push('dumbbell');
  if (hasGym)   allowed.push('barbell', 'cable', 'machine');
  return allowed;
}

// ── Load exercise library ─────────────────────────────────────────────────────
// libraryOverride: optional array (used by test script to avoid DB dependency)
async function loadLibrary(libraryOverride) {
  const rows = libraryOverride || await prisma.exerciseLibrary.findMany();
  const byId = new Map(rows.map(e => [e.id, e]));
  return { rows, byId };
}

// ── Closest real replacement for a hallucinated / disallowed ID ───────────────
function findReplacement(hallucinatedId, allExercises, allowedEquipment) {
  // Try matching by movement prefix (e.g. "SQUAT_TYPO" → "SQUAT_*")
  const prefix     = (hallucinatedId || '').split('_')[0];
  const byPrefix   = allExercises.filter(
    e => e.id.startsWith(prefix + '_') && allowedEquipment.includes(e.equipment)
  );
  if (byPrefix.length) return byPrefix[0];

  // Fall back to any allowed exercise
  return allExercises.find(e => allowedEquipment.includes(e.equipment)) || allExercises[0];
}

// ── Validate AI exercise proposals and replace any bad IDs ───────────────────
function validateAndMap(session, libraryById, allExercises, allowedEquipment) {
  const validated = (session.exercises || []).map(aiEx => {
    const real = libraryById.get(aiEx.libraryId);
    if (real && allowedEquipment.includes(real.equipment)) {
      return { ...aiEx, _lib: real, _replaced: false };
    }
    const replacement = findReplacement(aiEx.libraryId, allExercises, allowedEquipment);
    logger.warn(`[aiPlanGenerator] Replaced hallucinated ID "${aiEx.libraryId}" → "${replacement.id}"`);
    return { ...aiEx, libraryId: replacement.id, _lib: replacement, _replaced: true };
  });

  // Deterministically pad to MIN_EXERCISES — no AI loop risk
  if (!session.isRestDay && validated.length < MIN_EXERCISES) {
    const used       = new Set(validated.map(e => e._lib.id));
    const candidates = allExercises.filter(
      e => allowedEquipment.includes(e.equipment) && !used.has(e.id)
    );
    let i = 0;
    while (validated.length < MIN_EXERCISES && i < candidates.length) {
      const lib = candidates[i++];
      validated.push({
        libraryId: lib.id, sets: 3,
        reps: lib.defaultReps, durationSecs: lib.defaultSecs,
        restSeconds: 60, _lib: lib, _replaced: true,
      });
    }
  }

  return validated;
}

// ── Build final exercise object (format the frontend reads) ───────────────────
function buildExercise(validatedEx, sets) {
  const lib = validatedEx._lib;
  return {
    libraryId:       lib.id,
    name:            lib.name,
    muscleGroup:     lib.muscleGroup,
    equipment:       lib.equipment,
    sets:            validatedEx.sets || sets || 3,
    restSeconds:     validatedEx.restSeconds || 60,
    isCompound:      lib.isCompound,
    isTimedExercise: lib.isTimed,
    durationSecs:    lib.isTimed ? (validatedEx.durationSecs || lib.defaultSecs || 30) : null,
    reps:            lib.isTimed ? null : (validatedEx.reps || lib.defaultReps || 10),
    videoUrl:        lib.videoUrl || '',
  };
}

// ── Progressive overload sets per week ───────────────────────────────────────
function setsForWeek(level, weekNum) {
  const base = level === 'advanced' ? 5 : level === 'intermediate' ? 4 : 3;
  if (weekNum === 3) return base + 1;
  if (weekNum === 4) return Math.max(2, base - 1);
  return base;
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a certified personal trainer creating personalised workout plans.
You MUST only select exercises from the provided library — never invent IDs.
Return ONLY valid JSON with no markdown fencing or extra text.`;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// libraryOverride: optional Exercise[] array — if omitted, loads from DB
// ─────────────────────────────────────────────────────────────────────────────
async function generateAIPlan(user, libraryOverride = null) {
  const client = getAnthropicClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const { rows, byId } = await loadLibrary(libraryOverride);
  const allowedEquipment = getAllowedEquipment(user);
  const available        = rows.filter(e => allowedEquipment.includes(e.equipment));

  const daysPerWeek  = Math.min(Math.max(parseInt(user.daysPerWeek) || 3, 2), 6);
  const level        = (user.fitnessLevel || 'beginner').toLowerCase();
  const goal         = user.goal || 'general fitness';

  const exerciseList = available.map(e =>
    `${e.id} (${e.name}, ${e.muscleGroup}${e.isTimed ? `, TIMED default ${e.defaultSecs}s` : `, ${e.defaultReps} reps`})`
  ).join('\n');

  const userPrompt = `Create a 4-week progressive workout plan for this user:
- Fitness level: ${level}
- Goal: ${goal}
- Days per week: ${daysPerWeek}
- Available equipment: ${allowedEquipment.join(', ')}

Available exercises — use ONLY these exact IDs:
${exerciseList}

Return JSON matching exactly this schema:
{
  "planName": "string",
  "frequency": ${daysPerWeek},
  "level": "${level}",
  "totalWeeks": 4,
  "weeks": [
    {
      "weekNumber": 1,
      "sessions": [
        {
          "dayOfWeek": "Monday",
          "sessionName": "Full Body A",
          "isRestDay": false,
          "durationMins": 45,
          "exercises": [
            { "libraryId": "SQUAT_NONE", "sets": 3, "reps": 15, "durationSecs": null, "restSeconds": 60 }
          ]
        }
      ]
    }
  ]
}

Rules:
- Exactly 7 sessions per week (Monday through Sunday)
- ${daysPerWeek} training days, ${7 - daysPerWeek} rest days
- Rest days: isRestDay true, exercises empty array, durationMins 0, sessionName "Rest Day"
- Active sessions: 5–6 exercises each targeting balanced muscle groups
- Progressive overload: weeks 1–2 use base sets, week 3 add 1 set, week 4 subtract 1 set (deload)
- Timed exercises: durationSecs = the exercise default, reps = null
- Rep-based exercises: reps = the exercise default, durationSecs = null
- libraryId MUST be exactly from the list above — never invent new IDs`;

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system:     SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userPrompt },
    ],
  });

  let aiPlan;
  try {
    const raw = response.content[0].text.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    aiPlan = JSON.parse(raw);
  } catch {
    throw new Error('AI returned invalid JSON for plan');
  }

  // Build validated final plan
  const weeks = (aiPlan.weeks || []).map(week => {
    const weekNum = week.weekNumber;
    const sets    = setsForWeek(level, weekNum);
    const sessions = (week.sessions || []).map(session => {
      if (session.isRestDay) {
        return { dayOfWeek: session.dayOfWeek, sessionName: 'Rest Day', isRestDay: true, durationMins: 0, exercises: [] };
      }
      const validated = validateAndMap(session, byId, rows, allowedEquipment);
      return {
        dayOfWeek:   session.dayOfWeek,
        sessionName: session.sessionName,
        isRestDay:   false,
        durationMins: session.durationMins || 45,
        exercises:   validated.map(ex => buildExercise(ex, sets)),
      };
    });
    return { weekNumber: weekNum, sessions };
  });

  return {
    planName:   aiPlan.planName || `${level} ${goal} — ${daysPerWeek}×/week`,
    frequency:  daysPerWeek,
    level,
    totalWeeks: 4,
    weeks,
  };
}

module.exports = { generateAIPlan, getAllowedEquipment };
