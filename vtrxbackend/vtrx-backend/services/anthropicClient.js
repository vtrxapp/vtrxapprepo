// ─────────────────────────────────────────────────────────────────────────────
// services/anthropicClient.js — Shared Anthropic client singleton
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('../utils/logger');

let anthropic = null;

const getAnthropicClient = () => {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn('ANTHROPIC_API_KEY not set — AI features disabled');
      return null;
    }
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
};

module.exports = { getAnthropicClient };
