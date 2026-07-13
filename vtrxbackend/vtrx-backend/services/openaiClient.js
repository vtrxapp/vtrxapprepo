// ─────────────────────────────────────────────────────────────────────────────
// services/openaiClient.js — Shared OpenAI client singleton
// ─────────────────────────────────────────────────────────────────────────────

const OpenAI  = require('openai');
const logger  = require('../utils/logger');

let openai = null;

const getOpenAIClient = () => {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('OPENAI_API_KEY not set — AI features disabled');
      return null;
    }
    openai = new OpenAI({ apiKey });
  }
  return openai;
};

module.exports = { getOpenAIClient };
