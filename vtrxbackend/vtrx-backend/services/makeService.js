// ─────────────────────────────────────────────────────────────────────────────
// services/makeService.js — Make.com (formerly Integromat) webhook dispatcher
// ─────────────────────────────────────────────────────────────────────────────
// Each Make.com scenario exposes its own webhook URL. Store these in Railway:
//
//   MAKE_WEBHOOK_USER_SIGNUP      → Clerk/user signup  → Mailchimp + welcome flow
//   MAKE_WEBHOOK_SUBSCRIPTION     → Stripe payment      → Slack + CRM tag
//   MAKE_WEBHOOK_WORKOUT_COMPLETE → workout finished    → gamification / email drip
//   MAKE_WEBHOOK_SENTRY           → Sentry alert        → Linear bug ticket
//
// Usage:  await make.send('USER_SIGNUP', { email, name, plan })
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require('axios');
const logger = require('../utils/logger');

const HOOKS = {
  USER_SIGNUP:       process.env.MAKE_WEBHOOK_USER_SIGNUP,
  SUBSCRIPTION:      process.env.MAKE_WEBHOOK_SUBSCRIPTION,
  WORKOUT_COMPLETE:  process.env.MAKE_WEBHOOK_WORKOUT_COMPLETE,
  SENTRY:            process.env.MAKE_WEBHOOK_SENTRY,
};

// Fire-and-forget — never awaited in request handlers so it never blocks response
const send = (event, payload = {}) => {
  const url = HOOKS[event];
  if (!url) return;                     // env var not set → silently skip
  axios.post(url, { event, ...payload, _source: 'vtrx', _ts: new Date().toISOString() }, {
    timeout: 8000,
    headers: { 'Content-Type': 'application/json' },
  }).catch(err => logger.warn(`make.com ${event} webhook failed: ${err.message}`));
};

module.exports = { send };
