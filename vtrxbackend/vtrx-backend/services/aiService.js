// ─────────────────────────────────────────────────────────────────────────────
// services/aiService.js — GPT-4o AI Coaching Engine
// ─────────────────────────────────────────────────────────────────────────────

const OpenAI = require('openai');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are VTRX Coach, an elite AI fitness and nutrition coach built into the VTRX app.
You are direct, data-driven, motivating, and highly specific.
Never give generic advice. Always reference the user's actual data.
Keep responses concise — users read on mobile. Under 120 words unless asked for more.
Use an encouraging but honest tone. Never be sycophantic.`;

const callGPT = async (userPrompt, maxTokens = 300, temp = 0.7) => {
  try {
    const res = await openai.chat.completions.create({
      model:       'gpt-4o',
      max_tokens:  maxTokens,
      temperature: temp,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    });
    return {
      text:       res.choices[0].message.content,
      tokensUsed: res.usage?.total_tokens || 0,
      model:      'gpt-4o',
    };
  } catch (err) {
    logger.error('GPT-4o error:', err.message);
    return null;
  }
};

// ── Post-Workout Summary ───────────────────────────────────────────────────────
const generateWorkoutSummary = async ({
  workoutName, workoutType, duration, caloriesBurned,
  exercises, energyLevel, userGoal, streakDays, volume,
}) => {
  const prompt = `Analyse this completed workout and give a 2-3 sentence coaching summary.

WORKOUT: ${workoutName} (${workoutType}) — ${duration} min, ${caloriesBurned || '?'} cal burned
VOLUME: ${volume ? `${volume}kg total` : 'bodyweight/cardio'}
EXERCISES: ${exercises?.map(e => `${e.name} ${e.sets}×${e.reps}${e.weight ? ` @ ${e.weight}lbs` : ''}`).join(', ') || 'general training'}
ENERGY LEVEL TODAY: ${energyLevel || 'okay'}
USER GOAL: ${userGoal || 'general fitness'}
CURRENT STREAK: ${streakDays || 0} days

Provide:
1. Performance analysis (mention specific numbers)
2. One specific improvement for next session
3. One recovery or nutrition tip

Under 120 words. Be a coach, not a cheerleader.`;

  const result = await callGPT(prompt, 300);

  if (!result) {
    return {
      summary: `Solid ${workoutType?.toLowerCase() || 'training'} session — ${duration} minutes completed for ${workoutName}. Recovery is as important as the work. Prioritise sleep and protein today.`,
      keyInsights:     ['Session completed', `${duration} minutes of work`],
      recommendations: ['Focus on recovery', 'Hit your protein target today'],
      tokensUsed: 0,
      model: 'fallback',
    };
  }

  return {
    summary:         result.text,
    keyInsights:     [],
    recommendations: [],
    tokensUsed:      result.tokensUsed,
    model:           result.model,
  };
};

// ── Mood-Based Recommendation ─────────────────────────────────────────────────
const generateMoodRecommendation = async ({
  mood, userGoal, recentWorkouts, daysPerWeek, streakDays,
}) => {
  const moodMap = {
    empty: 'completely drained, no energy',
    low:   'below average energy',
    okay:  'moderate energy, feeling neutral',
    good:  'good energy, ready to work',
    peak:  'peak energy and motivation',
  };

  const prompt = `User energy check-in: ${mood} (${moodMap[mood] || 'moderate'})
Goal: ${userGoal || 'general fitness'}
Recent workouts: ${recentWorkouts?.slice(0, 3).join(', ') || 'unknown'}
Training frequency: ${daysPerWeek || 3} days/week
Current streak: ${streakDays || 0} days

Give a direct, specific recommendation for today:
1. Should they train or rest?
2. What type and intensity of training?
3. Key nutrition tip for their energy level

Under 100 words. Be specific and actionable.`;

  const result = await callGPT(prompt, 200, 0.6);

  const fallbacks = {
    empty: 'Complete rest today. Focus on nutrition — hit your protein target and stay hydrated. Your body is telling you something. Protect the streak by sleeping 8+ hours tonight.',
    low:   'Light movement only — a 20-minute walk or gentle stretching. Keep intensity low. Extra hydration and a protein-rich meal will set you up for a stronger session tomorrow.',
    okay:  'Moderate training is ideal. Stick to your programme and focus on form over weight. A solid session today builds consistency.',
    good:  'Strong day — push slightly harder than your last session. Progressive overload drives results. Fuel with complex carbs 90 minutes before.',
    peak:  'Hit your hardest session of the week. Max effort today. Extra carbs pre-workout, and plan for enhanced recovery after.',
  };

  return {
    recommendation: result?.text || fallbacks[mood] || fallbacks.okay,
    tokensUsed:     result?.tokensUsed || 0,
  };
};

// ── Weekly Progress Insight ────────────────────────────────────────────────────
const generateWeeklyInsight = async ({
  weeklyStats, previousWeek, userGoal, streakDays,
}) => {
  const change = previousWeek
    ? weeklyStats.workouts - previousWeek.workouts
    : 0;

  const prompt = `Generate a weekly fitness insight for this user.

THIS WEEK: ${weeklyStats.workouts} workouts, ${weeklyStats.totalMinutes} min total, ${weeklyStats.totalCalories} cal burned
LAST WEEK: ${previousWeek?.workouts || 'N/A'} workouts, ${previousWeek?.totalMinutes || 'N/A'} min
CHANGE: ${change > 0 ? `+${change}` : change} workouts vs last week
STREAK: ${streakDays} days
GOAL: ${userGoal || 'general fitness'}

Give a 2-3 sentence weekly review and one specific action item for next week.
Under 100 words. Reference the actual numbers.`;

  const result = await callGPT(prompt, 200, 0.6);

  return {
    insight:    result?.text || `You completed ${weeklyStats.workouts} workouts this week for ${weeklyStats.totalMinutes} total minutes. ${streakDays > 0 ? `${streakDays} day streak — consistency is your biggest weapon.` : 'Start building consistency next week.'}`,
    tokensUsed: result?.tokensUsed || 0,
  };
};

// ── Nutrition Recommendation ───────────────────────────────────────────────────
const generateNutritionAdvice = async ({
  mood, userGoal, todayWorkout, caloriesBurned,
}) => {
  const prompt = `Give specific nutrition advice for today.

ENERGY LEVEL: ${mood || 'okay'}
USER GOAL: ${userGoal || 'general fitness'}
TODAY'S WORKOUT: ${todayWorkout || 'rest day'}
CALORIES BURNED: ${caloriesBurned || 0}

Recommend:
1. Approximate calorie target for today
2. Macro priority (protein/carbs/fat focus)
3. One specific meal or food to prioritise

Under 80 words. Be specific with numbers.`;

  const result = await callGPT(prompt, 200, 0.6);

  return {
    advice:     result?.text || 'Aim for 1g protein per lb of bodyweight today. Prioritise whole foods and stay hydrated. Time carbohydrates around your workout for optimal performance.',
    tokensUsed: result?.tokensUsed || 0,
  };
};

// ── Personalised Workout Plan ─────────────────────────────────────────────────
const generateWorkoutPlan = async ({
  goal, fitnessLevel, daysPerWeek, equipment, location,
}) => {
  const prompt = `Design a ${daysPerWeek}-day workout programme.

USER: ${fitnessLevel || 'intermediate'} level
GOAL: ${goal || 'build muscle'}
EQUIPMENT: ${equipment?.join(', ') || 'full gym'}
LOCATION: ${location || 'gym'}

Provide a weekly schedule with:
- Day name and workout type
- 3 key exercises per day with sets x reps
- Rest days

Format as a clear weekly plan. Under 200 words.`;

  const result = await callGPT(prompt, 500, 0.7);

  return {
    plan:       result?.text || 'Contact your coach for a personalised plan.',
    tokensUsed: result?.tokensUsed || 0,
  };
};

// ── Recovery Assessment ───────────────────────────────────────────────────────
const generateRecoveryAdvice = async ({
  recentWorkouts, streakDays, mood, sleepHours,
}) => {
  const prompt = `Assess this athlete's recovery status.

RECENT WORKOUTS: ${recentWorkouts?.join(', ') || 'unknown'}
CONSECUTIVE DAYS: ${streakDays || 0}
ENERGY TODAY: ${mood || 'okay'}
SLEEP LAST NIGHT: ${sleepHours || 'unknown'} hours

Give a recovery assessment and recommendation. Should they push or recover?
Under 80 words.`;

  const result = await callGPT(prompt, 200, 0.5);

  return {
    advice:     result?.text || 'Listen to your body. If you feel fatigued, an active recovery day will serve you better than a hard session.',
    tokensUsed: result?.tokensUsed || 0,
  };
};

module.exports = {
  generateWorkoutSummary,
  generateMoodRecommendation,
  generateWeeklyInsight,
  generateNutritionAdvice,
  generateWorkoutPlan,
  generateRecoveryAdvice,
};
