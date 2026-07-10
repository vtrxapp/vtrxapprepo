const { getAnthropicClient } = require('./anthropicClient');
const logger  = require('../utils/logger');

const parseJSON = (raw, context) => {
  try {
    return JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
  } catch (err) {
    logger.warn(`AI JSON parse failed [${context}]: ${err.message} — raw: ${raw.slice(0, 200)}`);
    return null;
  }
};

const SYSTEM_PROMPT = `You are VTRX Coach, an elite AI fitness and nutrition coach built into the VTRX app.
You are direct, data-driven, motivating, and highly specific.
Never give generic advice. Always reference the user's actual data.
Use an encouraging but honest tone. Never be sycophantic.`;

const callGPT = async (userPrompt, maxTokens = 300) => {
  const client = getAnthropicClient();
  if (!client) return { text: 'AI coaching not available.', tokensUsed: 0, model: 'none' };

  try {
    const res = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return {
      text:       res.content[0].text,
      tokensUsed: (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0),
      model:      'claude-haiku-4-5-20251001',
    };
  } catch (err) {
    logger.error('Claude call failed:', err.message);
    throw err;
  }
};

const generateWorkoutSummary = async ({
  workoutName,
  workoutType,
  duration,
  caloriesBurned,
  exercises,
  energyLevel,
  userGoal,
  streakDays,
  personalBests = {},   // { exerciseName: { weight, reps } }
  moodHistory = [],
  avgCompletionRate = 100,
}) => {
  // Build detailed per-exercise breakdown for the prompt
  const exerciseLines = (exercises || []).map(ex => {
    const sets = (ex.sets || []).filter(s => s.completed !== false);
    const repsArr  = sets.map(s => parseInt(s.reps)    || 0);
    const weights  = sets.map(s => parseFloat(s.weight) || 0);
    const maxW     = Math.max(...weights, 0);
    const totalVol = sets.reduce((sum, s) => sum + (parseInt(s.reps)||0) * (parseFloat(s.weight)||0), 0);
    const prevBest = personalBests[ex.name];
    return [
      `Exercise: ${ex.name}`,
      `  Sets: ${sets.length}, Reps per set: [${repsArr.join(', ')}], Max weight: ${maxW}lb`,
      `  Total volume: ${totalVol.toFixed(0)}lb`,
      prevBest ? `  Previous best: ${prevBest.weight}lb x ${prevBest.reps} reps` : '  Previous best: none on record',
    ].join('\n');
  }).join('\n\n') || 'No exercise data';

  const prompt = `Generate a comprehensive AI workout recap as valid JSON.

Athlete data:
- Workout: ${workoutName} (${workoutType})
- Duration: ${duration} min | Calories: ${caloriesBurned || 'estimated'}
- Energy/mood going in: ${energyLevel || 'okay'} | Goal: ${userGoal || 'general fitness'}
- Current streak: ${streakDays || 0} days
${moodHistory.length ? `- Mood trend (last 7 days): ${moodHistory.join(', ')}` : ''}
${avgCompletionRate < 100 ? `- Average workout completion: ${avgCompletionRate}% (factor this into volume/intensity recommendations)` : ''}

Exercise log:
${exerciseLines}

Return ONLY valid JSON matching this exact schema (no markdown, no extra text):
{
  "summary": "2-3 sentence motivational coaching summary referencing actual numbers and exercises",
  "coachingInsights": "3-4 sentence detailed coaching analysis covering intensity, progression, consistency, and what the data means for their goal",
  "keyInsights": ["specific insight 1", "specific insight 2", "specific insight 3"],
  "recommendations": ["actionable next-session tip 1", "tip 2", "tip 3"],
  "exerciseBreakdown": [
    {
      "name": "exercise name",
      "setsCompleted": 3,
      "repsPerSet": [10, 10, 8],
      "maxWeight": 100,
      "totalVolume": 2800,
      "trend": "improved|maintained|declined",
      "isPR": false
    }
  ],
  "muscleGroups": [
    { "name": "Chest", "percentage": 35 },
    { "name": "Triceps", "percentage": 25 },
    { "name": "Shoulders", "percentage": 20 },
    { "name": "Core", "percentage": 20 }
  ],
  "metrics": {
    "completionRate": 95,
    "intensityScore": 72,
    "volumeLifted": 12500,
    "moodAlignmentScore": 85
  },
  "achievements": [
    { "icon": "🏆", "label": "New Bench Press PR" }
  ],
  "moodAnalysis": {
    "description": "1-2 sentence analysis of how mood aligned with performance",
    "moodImpact": "positive|neutral|negative"
  }
}`;

  const result = await callGPT(prompt, 1200, 0.7);
  const parsed = parseJSON(result.text, 'generateWorkoutSummary');
  if (parsed) {
    return {
      summary:         parsed.summary          || result.text,
      keyInsights:     parsed.keyInsights       || [],
      recommendations: parsed.recommendations   || [],
      recap: {
        coachingInsights:  parsed.coachingInsights  || '',
        exerciseBreakdown: parsed.exerciseBreakdown  || [],
        muscleGroups:      parsed.muscleGroups       || [],
        metrics:           parsed.metrics            || {},
        achievements:      parsed.achievements       || [],
        moodAnalysis:      parsed.moodAnalysis       || {},
      },
      model:      result.model,
      tokensUsed: result.tokensUsed,
    };
  }
  return { summary: result.text, keyInsights: [], recommendations: [], recap: null, model: result.model, tokensUsed: result.tokensUsed };
};

// ── generateMoodRecommendation ────────────────────────────────────────────────
const generateMoodRecommendation = async ({
  mood,
  userGoal,
  recentWorkouts = [],
  daysPerWeek,
  streakDays,
}) => {
  const moodLabels = { empty: 'completely drained', low: 'low energy', okay: 'average', good: 'good', peak: 'peak energy' };
  const recentList = recentWorkouts.length ? recentWorkouts.join(', ') : 'no recent workouts logged';

  const prompt = `A VTRX user just checked in with mood: "${moodLabels[mood] || mood}".

Context:
- Goal: ${userGoal || 'general fitness'}
- Recent workouts: ${recentList}
- Trains ${daysPerWeek || 3}x/week | Current streak: ${streakDays || 0} days

Return ONLY valid JSON (no markdown):
{
  "message": "2-3 sentence personalised coaching response that directly addresses their current mood and what it means for today",
  "todayAction": "One specific, concrete action they should take today given this mood",
  "adjustedWorkout": "Brief suggestion on how to adjust today's training based on their energy level",
  "motivationalCue": "One powerful short phrase (under 12 words) tailored to their goal"
}`;

  const result = await callGPT(prompt, 400, 0.75);
  const parsed = parseJSON(result.text, 'generateMoodRecommendation');
  return { recommendation: parsed || { message: result.text, todayAction: '', adjustedWorkout: '', motivationalCue: '' }, tokensUsed: result.tokensUsed };
};

// ── generateWeeklyInsight ─────────────────────────────────────────────────────
const generateWeeklyInsight = async ({
  weeklyStats,
  previousWeek,
  userGoal,
  streakDays,
}) => {
  const delta = (curr, prev) => {
    if (!prev) return 'no prior data';
    const pct = prev === 0 ? 'N/A' : `${((curr - prev) / prev * 100).toFixed(0)}%`;
    return curr > prev ? `up ${pct}` : curr < prev ? `down ${pct}` : 'same as last week';
  };

  const prompt = `Generate a weekly performance insight for a VTRX athlete.

This week:
- Workouts: ${weeklyStats.workouts} (${delta(weeklyStats.workouts, previousWeek.workouts)})
- Total time: ${weeklyStats.totalMinutes} min (${delta(weeklyStats.totalMinutes, previousWeek.totalMinutes)})
- Calories burned: ${weeklyStats.totalCalories} (${delta(weeklyStats.totalCalories, previousWeek.totalCalories)})

Goal: ${userGoal || 'general fitness'} | Streak: ${streakDays || 0} days

Return ONLY valid JSON (no markdown):
{
  "headline": "One punchy headline summarising this week (under 10 words)",
  "body": "3-4 sentence coaching analysis comparing this week to last, what the trend means for their goal, and one key takeaway",
  "weekRating": "excellent|strong|average|below-average|recovery-week",
  "focusForNextWeek": "One specific priority for next week based on the data",
  "badges": [
    { "icon": "🔥", "label": "Short achievement label" }
  ]
}`;

  const result = await callGPT(prompt, 500, 0.7);
  const parsed = parseJSON(result.text, 'generateWeeklyInsight');
  return { insight: parsed || { headline: 'Weekly Summary', body: result.text, weekRating: 'average', focusForNextWeek: '', badges: [] }, tokensUsed: result.tokensUsed };
};

// ── generateNutritionAdvice ───────────────────────────────────────────────────
const generateNutritionAdvice = async ({
  mood,
  userGoal,
  todayWorkout,
  caloriesBurned,
}) => {
  const prompt = `Give personalised nutrition advice to a VTRX athlete.

Today's data:
- Current mood/energy: ${mood || 'not specified'}
- Goal: ${userGoal || 'general fitness'}
- Today's workout: ${todayWorkout || 'rest day'}
- Calories burned: ${caloriesBurned || 0}

Return ONLY valid JSON (no markdown):
{
  "summary": "2-3 sentence personalised nutrition coaching message referencing their goal and today's activity",
  "dailyTargets": {
    "calories": 2400,
    "protein": 180,
    "carbs": 250,
    "fat": 70
  },
  "timingTips": ["Specific meal timing tip 1 based on their workout", "tip 2", "tip 3"],
  "priorityFoods": ["food 1 for their goal", "food 2", "food 3"],
  "avoidToday": ["thing to limit today based on their mood/goal"]
}`;

  const result = await callGPT(prompt, 500, 0.7);
  const parsed = parseJSON(result.text, 'generateNutritionAdvice');
  return { advice: parsed || { summary: result.text, dailyTargets: {}, timingTips: [], priorityFoods: [], avoidToday: [] }, tokensUsed: result.tokensUsed };
};

// ── generateWorkoutPlan ───────────────────────────────────────────────────────
const generateWorkoutPlan = async ({
  goal,
  fitnessLevel,
  daysPerWeek,
  equipment = [],
  location,
}) => {
  const equipmentList = equipment.length ? equipment.join(', ') : 'bodyweight only';

  const prompt = `Create a personalised ${daysPerWeek || 3}-day weekly workout plan for a VTRX athlete.

Profile:
- Goal: ${goal || 'general fitness'}
- Fitness level: ${fitnessLevel || 'Intermediate'}
- Training location: ${location || 'Full Gym'}
- Available equipment: ${equipmentList}

Return ONLY valid JSON (no markdown):
{
  "planName": "Short name for this programme",
  "overview": "2 sentence description of the programme philosophy and expected results",
  "weeklyStructure": [
    {
      "day": "Monday",
      "focus": "Upper Body Push",
      "type": "STRENGTH",
      "estimatedDuration": 50,
      "exercises": [
        {
          "name": "Bench Press",
          "sets": 4,
          "reps": "8-10",
          "restSecs": 90,
          "notes": "Focus on controlled eccentric"
        }
      ]
    }
  ],
  "progressionTip": "How to progress this plan week over week",
  "nutritionNote": "One key nutrition point for this programme"
}`;

  const result = await callGPT(prompt, 1500, 0.65);
  const parsed = parseJSON(result.text, 'generateWorkoutPlan');
  return { plan: parsed || { planName: 'Custom Plan', overview: result.text, weeklyStructure: [], progressionTip: '', nutritionNote: '' }, tokensUsed: result.tokensUsed };
};

// ── generateRecoveryAdvice ────────────────────────────────────────────────────
const generateRecoveryAdvice = async ({
  recentWorkouts = [],
  streakDays,
  mood,
  sleepHours,
}) => {
  const recentList = recentWorkouts.length ? recentWorkouts.join(', ') : 'no recent sessions';

  const prompt = `Give targeted recovery advice to a VTRX athlete.

Recovery context:
- Recent workouts: ${recentList}
- Current streak: ${streakDays || 0} days
- Current mood/energy: ${mood || 'not specified'}
- Sleep last night: ${sleepHours ? `${sleepHours} hours` : 'not reported'}

Return ONLY valid JSON (no markdown):
{
  "recoveryScore": 72,
  "statusLabel": "Good|Fair|Needs Attention|Critical",
  "summary": "2-3 sentence honest assessment of their current recovery state based on the data",
  "priorities": ["Most important recovery action right now", "second priority", "third priority"],
  "activeRecovery": ["Specific low-intensity activity recommendation", "mobility/stretch suggestion"],
  "nutritionFocus": "One specific nutrition priority for recovery today",
  "sleepTip": "Concrete sleep advice based on their hours reported",
  "tomorrowRecommendation": "train|active-recovery|full-rest"
}`;

  const result = await callGPT(prompt, 500, 0.7);
  const parsed = parseJSON(result.text, 'generateRecoveryAdvice');
  return { advice: parsed || { recoveryScore: 70, statusLabel: 'Fair', summary: result.text, priorities: [], activeRecovery: [], nutritionFocus: '', sleepTip: '', tomorrowRecommendation: 'active-recovery' }, tokensUsed: result.tokensUsed };
};

// ── generateMealPlan ──────────────────────────────────────────────────────────
const generateMealPlan = async ({
  goal,
  weight,
  fitnessLevel,
  todayWorkout,
  caloriesBurned,
}) => {
  const prompt = `Generate a personalised daily meal plan for a VTRX athlete.

Profile:
- Goal: ${goal || 'general fitness'}
- Weight: ${weight ? `${weight}kg` : 'not set'}
- Fitness level: ${fitnessLevel || 'Intermediate'}
- Today's workout: ${todayWorkout || 'rest day'}
- Calories burned today: ${caloriesBurned || 0}

Return ONLY valid JSON (no markdown):
{
  "dailyCalories": 2400,
  "macros": { "protein": 180, "carbs": 240, "fat": 70 },
  "meals": [
    {
      "time": "Breakfast",
      "targetTime": "7:00 AM",
      "name": "Meal name",
      "description": "Brief appetising description",
      "calories": 500,
      "protein": 35,
      "carbs": 55,
      "fat": 15,
      "ingredients": ["ingredient 1", "ingredient 2"],
      "prepMinutes": 10
    }
  ],
  "hydrationGoal": 3.0,
  "coachNote": "One sentence personalised nutrition tip for today"
}`;

  const result = await callGPT(prompt, 900, 0.65);
  const parsed = parseJSON(result.text, 'generateMealPlan');
  return { mealPlan: parsed || null, tokensUsed: result.tokensUsed };
};

module.exports = {
  callGPT,
  generateWorkoutSummary,
  generateMoodRecommendation,
  generateWeeklyInsight,
  generateNutritionAdvice,
  generateWorkoutPlan,
  generateRecoveryAdvice,
  generateMealPlan,
};
