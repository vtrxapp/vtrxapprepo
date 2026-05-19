// ─────────────────────────────────────────────────────────────────────────────
// controllers/paymentController.js — Stripe Payment Controller
// ─────────────────────────────────────────────────────────────────────────────

const stripe       = require('../services/stripeService');
const prisma       = require('../config/database');
const logger       = require('../utils/logger');

// ── POST /api/payments/create-checkout ────────────────────────────────────────
// Creates a Stripe Checkout session → returns URL to redirect user to
const createCheckout = async (req, res) => {
  const { plan = 'monthly' } = req.body;

  if (!['monthly', 'annual'].includes(plan)) {
    return res.status(400).json({ success: false, message: 'Invalid plan' });
  }

  try {
    const baseUrl    = process.env.FRONTEND_URL || 'http://localhost:5173';
    const successUrl = `${baseUrl}/payment/success`;
    const cancelUrl  = `${baseUrl}/payment/cancel`;

    const session = await stripe.createCheckoutSession({
      user: req.user,
      plan,
      successUrl,
      cancelUrl,
    });

    res.json({
      success: true,
      data:    { url: session.url, sessionId: session.id },
    });
  } catch (err) {
    logger.error('Create checkout error:', err);
    res.status(500).json({ success: false, message: 'Failed to create checkout session' });
  }
};

// ── POST /api/payments/portal ─────────────────────────────────────────────────
// Opens Stripe Customer Portal for subscription management
const createPortal = async (req, res) => {
  try {
    const baseUrl  = process.env.FRONTEND_URL || 'http://localhost:5173';
    const session  = await stripe.createPortalSession({
      user:      req.user,
      returnUrl: `${baseUrl}/profile`,
    });

    res.json({ success: true, data: { url: session.url } });
  } catch (err) {
    logger.error('Create portal error:', err);
    res.status(500).json({ success: false, message: 'Failed to open billing portal' });
  }
};

// ── GET /api/payments/status ──────────────────────────────────────────────────
// Returns current subscription status for the logged-in user
const getStatus = async (req, res) => {
  try {
    const status = await stripe.getSubscriptionStatus(req.user.id);
    res.json({ success: true, data: status });
  } catch (err) {
    logger.error('Get status error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch subscription status' });
  }
};

// ── POST /api/payments/webhook ────────────────────────────────────────────────
// Stripe webhook — MUST use raw body, not parsed JSON
// This is how Stripe tells us about payments, cancellations etc.
const webhook = async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  try {
    const result = await stripe.handleWebhookEvent(req.body, signature);
    res.json(result);
  } catch (err) {
    logger.error('Webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ── POST /api/payments/verify-session ─────────────────────────────────────────
// Called after Stripe redirects back with ?session_id=xxx
// Verifies the payment actually went through
const verifySession = async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ success: false, message: 'Session ID required' });
  }

  try {
    const Stripe  = require('stripe');
    const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    const session = await stripeClient.checkout.sessions.retrieve(sessionId);

    const isPaid  = session.payment_status === 'paid' || session.status === 'complete';

    if (isPaid) {
      // Double-check user is marked as premium (webhook should have done this)
      await prisma.user.update({
        where: { id: req.user.id },
        data:  { isPremium: true },
      });
    }

    res.json({
      success: true,
      data: {
        paid:      isPaid,
        plan:      session.metadata?.plan,
        isPremium: isPaid,
      },
    });
  } catch (err) {
    logger.error('Verify session error:', err);
    res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
};

module.exports = { createCheckout, createPortal, getStatus, webhook, verifySession };
