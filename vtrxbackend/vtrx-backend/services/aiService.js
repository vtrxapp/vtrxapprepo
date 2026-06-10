const OpenAI = require('openai');
const logger = require('../utils/logger');

let openai = null;
const getClient = () => {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      logger.warn('OPENAI_API_KEY not set — AI features disabled');
      return null;
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
};

const SYSTEM_PROMPT = `You are VTRX Coach, an elite AI fitness and nutrition coach built into the VTRX app.
You are direct, data-driven, motivating, and highly specific.
Never give generic advice. Always reference the user's actual data.
Use an encouraging but honest tone. Never be sycophantic.`;

const callGPT = async (userPrompt, maxTokens = 300, temp = 0.7) => {
  const client = getClient();
  if (!client) return { text: 'AI coaching not available.', tokensUsed: 0, model: 'none' };

  try {
    const res = await client.chat.completions.create({
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
    logger.error('GPT call failed:', err.message);
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

  try {
    const text   = result.text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(text);
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
  } catch {
    return {
      summary:         result.text,
      keyInsights:     [],
      recommendations: [],
      recap:           null,
      model:           result.model,
      tokensUsed:      result.tokensUsed,
    };
  }
};

module.exports = { callGPT, generateWorkoutSummary };
