const OpenAI = require('openai');
const logger = require('../utils/logger');

// Lazy init — only create client if API key exists
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
Keep responses concise — users read on mobile. Under 120 words unless asked for more.
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
}) => {
  const exerciseSummary = (exercises || [])
    .map(ex => {
      const completedSets = (ex.sets || []).filter(s => s.completed !== false);
      const vol = completedSets.reduce(
        (sum, s) => sum + ((parseInt(s.reps) || 0) * (parseFloat(s.weight) || 0)),
        0
      );
      return `${ex.name || 'exercise'}: ${completedSets.length} sets, ${vol.toFixed(0)} lbs volume`;
    })
    .join('\n') || 'No exercise data';

  const prompt = `Generate a brief post-workout coaching summary.

Workout: ${workoutName} (${workoutType})
Duration: ${duration} min | Calories: ${caloriesBurned || 'N/A'}
Energy level: ${energyLevel || 'normal'} | Goal: ${userGoal || 'general fitness'}
Streak: ${streakDays || 0} days

Exercises:
${exerciseSummary}

Return valid JSON only:
{
  "summary": "2-3 sentence motivational summary referencing actual numbers",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "recommendations": ["next session tip 1", "next session tip 2"]
}`;

  const result = await callGPT(prompt, 450, 0.7);

  try {
    const text = result.text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(text);
    return {
      summary:         parsed.summary         || result.text,
      keyInsights:     parsed.keyInsights      || [],
      recommendations: parsed.recommendations  || [],
      model:           result.model,
      tokensUsed:      result.tokensUsed,
    };
  } catch {
    return {
      summary:         result.text,
      keyInsights:     [],
      recommendations: [],
      model:           result.model,
      tokensUsed:      result.tokensUsed,
    };
  }
};

module.exports = { callGPT, generateWorkoutSummary };
