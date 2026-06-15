const OpenAI  = require('openai');
const logger  = require('../utils/logger');

let _openai = null;
const getClient = () => {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) { logger.warn('OPENAI_API_KEY not set — embeddings disabled'); return null; }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
};

const MODEL = 'text-embedding-3-small'; // 1536 dimensions
const BATCH  = 96;                       // max texts per API call

// Embed a single text string → Float32Array
const embedText = async (text) => {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.embeddings.create({ model: MODEL, input: text.slice(0, 8000) });
    return res.data[0].embedding;
  } catch (err) {
    logger.error('embedText error:', err.message);
    return null;
  }
};

// Embed multiple texts in batches → [Float32Array, ...]
const embedBatch = async (texts) => {
  const client = getClient();
  if (!client) return texts.map(() => null);
  const results = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH).map(t => t.slice(0, 8000));
    try {
      const res = await client.embeddings.create({ model: MODEL, input: slice });
      results.push(...res.data.map(d => d.embedding));
    } catch (err) {
      logger.error('embedBatch error:', err.message);
      results.push(...slice.map(() => null));
    }
  }
  return results;
};

// ── Text builders ─────────────────────────────────────────────────────────────
const workoutText = (w) =>
  [w.name, w.type, w.description, w.difficulty,
   `${w.duration} minutes`, `${w.calories || ''} calories`,
   (w.exercises || []).map(e => e.exercise?.name || e.name || '').join(' ')]
  .filter(Boolean).join(' ');

const recipeText = (r) =>
  [r.name, r.description,
   `${r.calories} calories`, `${r.protein}g protein`, `${r.carbs}g carbs`,
   (r.tags || []).join(' '),
   (r.ingredients || []).join(' ')]
  .filter(Boolean).join(' ');

const userText = (u) =>
  [u.goal, u.fitnessLevel,
   u.location, `${u.daysPerWeek || 3} days per week`,
   (u.equipment || []).join(' '),
   u.gender, u.age ? `age ${u.age}` : '']
  .filter(Boolean).join(' ');

module.exports = { embedText, embedBatch, workoutText, recipeText, userText };
