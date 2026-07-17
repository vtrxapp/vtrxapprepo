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
    const result = await stripe.handleWebhookEvent(req.rawBody, signature);
    res.json(result);
  } catch (err) {
    logger.error(`Webhook error: ${err.message}`);
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

    // The session must belong to the authenticated user — without this check,
    // any authenticated caller could pass any Stripe session id (their own from
    // a cancelled plan, a leaked one, or another user's) and self-activate Premium.
    if (session.metadata?.userId !== req.user.id) {
      logger.warn(`verifySession ownership mismatch: session ${sessionId} not owned by ${req.user.id}`);
      return res.status(403).json({ success: false, message: 'Session does not belong to this user' });
    }

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

// ── POST /api/payments/create-subscription-intent ────────────────────────────
// Creates a Stripe subscription in default_incomplete state and returns the
// client_secret needed by Stripe.js to confirm payment in-app.
// Trial → returns a SetupIntent secret (seti_...); no-trial → PaymentIntent (pi_...).
const createSubscriptionIntent = async (req, res) => {
  const { plan = 'monthly' } = req.body;

  if (!['monthly', 'annual'].includes(plan)) {
    return res.status(400).json({ success: false, message: 'Invalid plan' });
  }

  try {
    const StripeSDK    = require('stripe');
    const stripeClient = new StripeSDK(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    // Get or create Stripe customer
    const customerId = await stripe.createOrGetCustomer(req.user);

    const priceId = plan === 'annual'
      ? process.env.STRIPE_ANNUAL_PRICE_ID
      : process.env.STRIPE_MONTHLY_PRICE_ID;

    if (!priceId || priceId.startsWith('paste_your') || priceId.startsWith('price_REPLACE')) {
      logger.error(`Stripe price ID not configured for plan: ${plan}`);
      return res.status(503).json({
        success: false,
        message: 'Payment is not yet configured. Please contact support.',
      });
    }

    const subscription = await stripeClient.subscriptions.create({
      customer:         customerId,
      items:            [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
        payment_method_types:        ['card'],
      },
      trial_period_days: 30,
      metadata:          { userId: req.user.id, plan },
      expand:            ['latest_invoice.payment_intent', 'pending_setup_intent'],
    });

    // Trials produce a SetupIntent (save card, no charge yet)
    // Non-trials produce a PaymentIntent (charge immediately)
    const clientSecret =
      subscription.pending_setup_intent?.client_secret ??
      subscription.latest_invoice?.payment_intent?.client_secret;

    if (!clientSecret) {
      throw new Error('Stripe did not return a client secret');
    }

    res.json({
      success: true,
      data: {
        clientSecret,
        subscriptionId: subscription.id,
        isTrial:        !!subscription.pending_setup_intent,
      },
    });
  } catch (err) {
    logger.error('Create subscription intent error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to create subscription' });
  }
};

// ── GET /api/payments/methods ─────────────────────────────────────────────────
// Returns the user's saved Stripe payment methods (cards only)
const getPaymentMethods = async (req, res) => {
  try {
    const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });

    if (!sub?.stripeCustomerId) {
      return res.json({ success: true, data: { methods: [] } });
    }

    const StripeSDK      = require('stripe');
    const stripeClient   = new StripeSDK(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    const [methodsList, customer] = await Promise.all([
      stripeClient.paymentMethods.list({ customer: sub.stripeCustomerId, type: 'card' }),
      stripeClient.customers.retrieve(sub.stripeCustomerId),
    ]);

    const defaultId = customer.invoice_settings?.default_payment_method;

    const methods = methodsList.data.map(m => ({
      id:        m.id,
      brand:     m.card.brand,
      last4:     m.card.last4,
      expMonth:  m.card.exp_month,
      expYear:   m.card.exp_year,
      isDefault: m.id === defaultId,
    }));

    res.json({ success: true, data: { methods } });
  } catch (err) {
    logger.error('Get payment methods error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch payment methods' });
  }
};

// ── GET /api/payments/invoices ────────────────────────────────────────────────
// Returns the user's Stripe invoice history
const getBillingHistory = async (req, res) => {
  try {
    const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });

    if (!sub?.stripeCustomerId) {
      return res.json({ success: true, data: { invoices: [] } });
    }

    const StripeSDK    = require('stripe');
    const stripeClient = new StripeSDK(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    const list = await stripeClient.invoices.list({
      customer: sub.stripeCustomerId,
      limit:    24,
      status:   'paid',
    });

    const invoices = list.data.map(inv => {
      const lineDesc = inv.lines?.data?.[0]?.description || 'Premium Plan';
      const cleanDesc = lineDesc.replace(/\(.*?\)/g, '').trim() || 'Premium Plan';
      return {
        id:     inv.id,
        date:   new Date(inv.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        desc:   cleanDesc,
        amount: `$${(inv.amount_paid / 100).toFixed(2)}`,
        method: inv.payment_intent ? (inv.charge?.payment_method_details?.card?.brand || '') : '',
        last4:  inv.charge?.payment_method_details?.card?.last4 || '',
        status: inv.status === 'paid' ? 'Paid' : inv.status === 'open' ? 'Due' : 'Failed',
      };
    });

    res.json({ success: true, data: { invoices } });
  } catch (err) {
    logger.error('Get billing history error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch billing history' });
  }
};

module.exports = { createCheckout, createPortal, getStatus, webhook, verifySession, getPaymentMethods, getBillingHistory, createSubscriptionIntent };
