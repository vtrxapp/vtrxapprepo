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

module.exports = { callGPT };
