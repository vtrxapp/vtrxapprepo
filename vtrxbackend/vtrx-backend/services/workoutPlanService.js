// ─────────────────────────────────────────────────────────────────────────────
// services/workoutPlanService.js — AI Workout Plan Generator (OpenAI)
// ─────────────────────────────────────────────────────────────────────────────

const { getOpenAIClient } = require('./openaiClient');
const logger              = require('../utils/logger');

const SYSTEM_PROMPT = `You are VTRX's AI personal trainer. You create professional, science-based workout plans tailored to each user's exact profile. Every plan must be:

- Appropriate for the user's experience level
- Achievable within their available time
- Possible with only the equipment they have
- Aligned with their primary goal
- Adjusted for their sex and body metrics
- Progressive over the plan duration

You respond ONLY in valid JSON. No markdown, no explanation, just the JSON object.`;

// ── Map equipment array to readable text ──────────────────────────────────────
const buildEquipmentText = (equipment = [], location = '') => {
  const eq = (equipment || []).map(e => e.toLowerCase());
  const isFullGym = location === 'Full Gym' ||
    eq.some(e => e.includes('full gym') || e.includes('cable machine'));

  if (isFullGym) {
    return [
      'Dumbbells: yes', 'Barbell: yes', 'Bench: yes',
      'Pull-up bar: yes', 'Full gym access: yes (cables, machines, leg press, etc.)',
    ].join('\n');
  }
  return [
    `Dumbbells: ${eq.some(e => e.includes('dumbbell')) ? 'yes' : 'no'}`,
    `Barbell: ${eq.some(e => e.includes('barbell')) ? 'yes' : 'no'}`,
    `Bench: ${eq.some(e => e.includes('bench')) ? 'yes' : 'no'}`,
    `Pull-up bar: ${eq.some(e => e.includes('pull')) ? 'yes' : 'no'}`,
    `Full gym access: no`,
    eq.some(e => e.includes('no equipment') || e.includes('bodyweight'))
      ? 'Bodyweight only — no equipment available' : '',
  ].filter(Boolean).join('\n');
};

// ── Build the user prompt from user profile ────────────────────────────────────
const buildUserPrompt = (user) => {
  const goal         = user.goal          || 'Stay Active';
  const level        = user.fitnessLevel  || 'Beginner';
  const days         = user.daysPerWeek   || 3;
  const gender       = user.gender        || 'Prefer not to say';
  const age          = user.age           || 30;
  const weight       = user.weight        || 'unknown';
  const height       = user.height        || 'unknown';
  const duration     = user.sessionDuration || '30-45 min';
  const styles       = (user.preferredStyles || []).join(', ') || 'No preference';
  const equipment    = buildEquipmentText(user.equipment, user.location);
  const name         = user.name ? user.name.split(' ')[0] : null;

  const freqLabel =
    days <= 2 ? '1-2 days per week' :
    days <= 4 ? '3-4 days per week' : '5+ days per week';

  return `Create a 4-week workout plan for this user:

PROFILE:
- Name: ${name || 'not provided'}
- Age: ${age}
- Sex: ${gender}
- Weight: ${weight} kg
- Height: ${height}

GOALS AND PREFERENCES:
- Primary goal: ${goal}
- Experience level: ${level}
- Preferred styles: ${styles}
- Sessions per week: ${freqLabel}
- Time per session: ${duration}

AVAILABLE EQUIPMENT:
${equipment}

PLAN REQUIREMENTS — apply these rules strictly:

1. EXPERIENCE LEVEL RULES:
   Beginner: Max 4 exercises/session, 2-3 sets, compound movements only, form cues required, 60-90s rest, no high-injury-risk moves.
   Intermediate: 4-6 exercises, 3-4 sets, compound + isolation, 45-75s rest, progressive overload week over week.
   Advanced: 5-8 exercises, 4-5 sets, supersets allowed, 30-60s rest, complex programming.
   Professional: 6-10 exercises, full periodisation, drop sets, pyramids, detailed progression.

2. GOAL-SPECIFIC RULES:
   Build Muscle: 6-12 reps, progressive overload, compound first, higher volume.
   Lose Weight: 12-20 reps, short rests, cardio finishers, HIIT circuits.
   Stay Active: 10-15 reps, moderate intensity, variety, include mobility.
   Improve Endurance: 15-25 reps, circuit style, minimal rest, cardio integration.
   Get Toned: 12-15 reps, muscle endurance, body composition focus, cardio finishers.

3. EQUIPMENT RULES (STRICT — only use exercises compatible with listed equipment):
   No equipment: push-ups, squats, lunges, burpees, mountain climbers, planks, glute bridges, jumping jacks, high knees, bear crawls, pike push-ups.
   With dumbbells: add dumbbell press, row, shoulder press, curl, tricep extension, goblet squat, RDL, lateral raise, fly.
   With barbell: add barbell squat, deadlift, row, overhead press, Romanian deadlift, curl.
   With bench: add bench press, incline press, step-ups, Bulgarian split squat, chest-supported row.
   Full gym: all above plus machines, cables, leg press, lat pulldown, cable row, leg curl, leg extension.

4. SEX-SPECIFIC ADJUSTMENTS:
   Male: Emphasise chest, shoulders, back width, arms. More upper body pushing volume.
   Female: Emphasise glutes, hamstrings, core. More hip hinge and glute isolation, lower body volume.
   Other/Prefer not to say: Balanced full-body emphasis.
   Always respect primary goal above sex-specific defaults.

5. SESSION DURATION:
   15-30 min: max 4 exercises, 2-3 sets, 30-45s rest, superset preferred.
   30-45 min: 4-5 exercises, 3 sets, 45-60s rest.
   45-60 min: 5-7 exercises, 3-4 sets, 60-75s rest.
   60+ min: 7-10 exercises, 4-5 sets, full rest.

6. FREQUENCY:
   1-2 days: Full body every session, cover all major muscle groups.
   3-4 days: Upper/Lower split (Day A: upper push, Day B: lower, Day C: upper pull, Day D: lower+core).
   5+ days: Push/Pull/Legs split with active recovery days.

7. AGE ADJUSTMENTS:
   Under 30: Standard. 30-45: +10% warm-up, +15s rest. 45-60: Reduce high-impact, add mobility, lower rep/moderate weight. 60+: Low-impact only, extended warm-up, joint-friendly selection.

RESPOND WITH THIS EXACT JSON STRUCTURE (no markdown, pure JSON):
{
  "plan_name": "string",
  "plan_summary": "string (max 50 words)",
  "duration_weeks": 4,
  "sessions_per_week": number,
  "estimated_calories_per_session": number,
  "primary_focus": "string",
  "progression_note": "string",
  "weekly_structure": {
    "week_1": {
      "theme": "string",
      "sessions": [
        {
          "day": "string",
          "session_name": "string",
          "session_type": "string",
          "duration_mins": number,
          "warm_up": [{"exercise": "string", "duration_secs": number, "notes": "string"}],
          "exercises": [
            {
              "name": "string",
              "sets": number,
              "reps": "string",
              "rest_secs": number,
              "tempo": "string",
              "form_cue": "string",
              "equipment_needed": "string",
              "ymove_search_term": "string"
            }
          ],
          "cool_down": [{"exercise": "string", "duration_secs": number}],
          "session_notes": "string"
        }
      ]
    },
    "week_2": {"theme": "string", "sessions": []},
    "week_3": {"theme": "string", "sessions": []},
    "week_4": {"theme": "string", "sessions": []}
  },
  "nutrition_note": "string",
  "ai_coach_message": "string (max 30 words${name ? `, address ${name} by name` : ''})"
}`;
};

// ── Parse JSON safely (strip any accidental markdown fences) ──────────────────
const parseJSON = (raw) => {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error('Plan JSON parse failed:', err.message, '— raw snippet:', raw.slice(0, 300));
    throw new Error('AI returned invalid JSON');
  }
};

// ── Main export ───────────────────────────────────────────────────────────────
const generateWorkoutPlan = async (user) => {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY not configured');

  const userPrompt = buildUserPrompt(user);

  logger.info(`Generating AI workout plan for user ${user.id} (${user.goal}, ${user.fitnessLevel})`);

  const response = await client.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 8000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ],
  });

  const text = response.choices[0].message.content || '';
  const plan = parseJSON(text);

  logger.info(`Plan generated for user ${user.id}: "${plan.plan_name}" (${response.usage?.completion_tokens || 0} tokens)`);
  return plan;
};

module.exports = { generateWorkoutPlan };
