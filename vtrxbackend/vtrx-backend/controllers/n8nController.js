const crypto  = require('crypto');
const Stripe  = require('stripe');
const prisma  = require('../config/database');
const logger   = require('../utils/logger');
const { sendWelcomeEmail } = require('../services/emailService');
const stripeService = require('../services/stripeService');

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Verify shared secret so only n8n can call these endpoints. Constant-time
// compare — a naive !== short-circuits on the first mismatched byte, which
// leaks timing information about the correct secret.
const verifySecret = (req, res) => {
  const secret   = req.headers['x-n8n-secret'] || '';
  const expected = process.env.N8N_WEBHOOK_SECRET || '';
  const a = Buffer.from(secret);
  const b = Buffer.from(expected);
  const match = !!expected && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    res.status(401).json({ success: false, message: 'Unauthorised' });
    return false;
  }
  return true;
};

// POST /api/n8n/send-welcome
// n8n calls this after adding a user to Mailchimp to also send the Resend welcome email
const sendWelcome = async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'email required' });
  await sendWelcomeEmail({ email, name }).catch(() => {});
  res.json({ success: true });
};

// POST /api/n8n/tag-premium
// n8n calls this after a Stripe checkout to mark user premium in our DB immediately
// (the Stripe webhook is the real source of truth and will also activate premium —
// this is just to close the gap while that event is in flight). The shared secret
// alone is not proof of payment, so this also requires a real Stripe subscriptionId
// and verifies it against Stripe before granting anything.
const tagPremium = async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { email, subscriptionId } = req.body;
  if (!email || !subscriptionId) {
    return res.status(400).json({ success: false, message: 'email and subscriptionId required' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
    const belongsToUser = sub.metadata?.userId === user.id;
    const isActive      = ['active', 'trialing'].includes(sub.status);

    if (!belongsToUser || !isActive) {
      logger.warn(`n8n tagPremium rejected: subscription ${subscriptionId} not a valid active subscription for user ${user.id}`);
      return res.status(400).json({ success: false, message: 'Subscription is not a valid active subscription for this user' });
    }

    await stripeService.activatePremium({
      userId:               user.id,
      plan:                 sub.metadata?.plan || 'monthly',
      stripeSubscriptionId: sub.id,
    });
    logger.info(`n8n tagPremium: premium activated for user ${user.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('n8n tagPremium error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/n8n/send-notification
// n8n calls this to trigger an in-app notification for a user
const sendNotification = async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { email, title, body, type = 'n8n_trigger' } = req.body;
  if (!email || !title || !body) {
    return res.status(400).json({ success: false, message: 'email, title, body required' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await prisma.notification.create({
      data: { userId: user.id, type, title, body },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('n8n sendNotification error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { sendWelcome, tagPremium, sendNotification };
