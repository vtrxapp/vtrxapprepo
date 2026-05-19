// ─────────────────────────────────────────────────────────────────────────────
// services/stripeService.js — Stripe Payment Integration
// ─────────────────────────────────────────────────────────────────────────────
// Stripe handles all credit card processing. We never touch card numbers —
// Stripe's SDK collects them securely on the frontend.
//
// Flow:
// 1. User taps "Subscribe" → frontend calls /api/payments/create-checkout
// 2. Backend creates a Stripe Checkout session → returns URL
// 3. Frontend opens the Stripe-hosted checkout page
// 4. User enters card details on Stripe's page (PCI compliant)
// 5. Stripe redirects back to our app with success/cancel
// 6. Stripe sends a webhook to /api/payments/webhook
// 7. Webhook updates user.isPremium = true in our database
// ─────────────────────────────────────────────────────────────────────────────

const Stripe = require('stripe');
const prisma  = require('../config/database');
const logger  = require('../utils/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// ── Create a Stripe Customer ───────────────────────────────────────────────────
// Every paying user needs a Stripe customer record
const createOrGetCustomer = async (user) => {
  // Return existing Stripe customer if we have one
  const sub = await prisma.subscription.findUnique({
    where: { userId: user.id },
  });

  if (sub?.stripeCustomerId) {
    return sub.stripeCustomerId;
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email:    user.email,
    name:     user.name || user.username,
    metadata: { userId: user.id },
  });

  // Save to our database
  await prisma.subscription.upsert({
    where:  { userId: user.id },
    create: {
      userId:           user.id,
      plan:             'free',
      status:           'inactive',
      stripeCustomerId: customer.id,
    },
    update: { stripeCustomerId: customer.id },
  });

  logger.info(`Stripe customer created: ${customer.id} for user ${user.id}`);
  return customer.id;
};

// ── Create Checkout Session ────────────────────────────────────────────────────
// Returns a URL the frontend redirects to for payment
const createCheckoutSession = async ({ user, plan, successUrl, cancelUrl }) => {
  const customerId = await createOrGetCustomer(user);

  const priceId = plan === 'annual'
    ? process.env.STRIPE_ANNUAL_PRICE_ID
    : process.env.STRIPE_MONTHLY_PRICE_ID;

  const session = await stripe.checkout.sessions.create({
    customer:    customerId,
    mode:        'subscription',
    line_items: [{
      price:    priceId,
      quantity: 1,
    }],

    // Where to redirect after payment
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
    cancel_url:  cancelUrl,

    // Pre-fill the customer's email
    customer_email: !customerId ? user.email : undefined,

    // Allow promotional codes (useful for discounts)
    allow_promotion_codes: true,

    // Pass metadata so we know which user this is in the webhook
    metadata: {
      userId: user.id,
      plan,
    },

    subscription_data: {
      metadata: {
        userId: user.id,
        plan,
      },
      // Give new users a 7-day free trial
      trial_period_days: 30,
    },
  });

  logger.info(`Checkout session created: ${session.id} for user ${user.id}`);
  return session;
};

// ── Create Customer Portal Session ────────────────────────────────────────────
// Lets users manage their subscription (cancel, update payment method etc)
const createPortalSession = async ({ user, returnUrl }) => {
  const sub = await prisma.subscription.findUnique({
    where: { userId: user.id },
  });

  if (!sub?.stripeCustomerId) {
    throw new Error('No Stripe customer found for this user');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer:   sub.stripeCustomerId,
    return_url: returnUrl,
  });

  return session;
};

// ── Handle Webhook Events ──────────────────────────────────────────────────────
// Stripe sends these events to tell us what happened with a payment
const handleWebhookEvent = async (rawBody, signature) => {
  let event;

  // Verify the webhook came from Stripe (not someone spoofing it)
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error(`Stripe webhook signature failed: ${err.message}`);
    throw new Error('Invalid webhook signature');
  }

  // Prevent processing the same event twice
  const existing = await prisma.stripeEvent.findUnique({
    where: { id: event.id },
  });

  if (existing?.processed) {
    logger.info(`Stripe event already processed: ${event.id}`);
    return { received: true, duplicate: true };
  }

  // Log the event
  await prisma.stripeEvent.upsert({
    where:  { id: event.id },
    create: { id: event.id, type: event.type, data: event.data, processed: false },
    update: {},
  });

  // Handle specific events
  switch (event.type) {

    // ── Payment succeeded → activate premium ────────────────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId  = session.metadata?.userId;
      const plan    = session.metadata?.plan || 'monthly';

      if (!userId) break;

      await activatePremium({ userId, plan, stripeSubscriptionId: session.subscription });
      logger.info(`Premium activated for user ${userId} via checkout`);
      break;
    }

    // ── Subscription renewed ────────────────────────────────────────────────
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const subId   = invoice.subscription;

      if (!subId) break;

      const sub = await stripe.subscriptions.retrieve(subId);
      const userId = sub.metadata?.userId;
      if (!userId) break;

      await prisma.subscription.updateMany({
        where: { stripeSubId: subId },
        data: {
          status:           'active',
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
        },
      });

      // Ensure isPremium stays true
      await prisma.user.update({
        where: { id: userId },
        data:  { isPremium: true },
      });

      logger.info(`Subscription renewed for user ${userId}`);
      break;
    }

    // ── Payment failed ──────────────────────────────────────────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const subId   = invoice.subscription;
      if (!subId) break;

      const sub = await stripe.subscriptions.retrieve(subId);
      const userId = sub.metadata?.userId;
      if (!userId) break;

      await prisma.subscription.updateMany({
        where: { stripeSubId: subId },
        data:  { status: 'past_due' },
      });

      // Create a notification so the user sees payment failed
      await prisma.notification.create({
        data: {
          userId,
          type:  'payment_failed',
          title: 'Payment Failed',
          body:  'We could not process your payment. Please update your payment method to keep Premium access.',
        },
      });

      logger.warn(`Payment failed for user ${userId}`);
      break;
    }

    // ── Subscription cancelled ──────────────────────────────────────────────
    case 'customer.subscription.deleted': {
      const sub    = event.data.object;
      const userId = sub.metadata?.userId;
      if (!userId) break;

      await prisma.user.update({
        where: { id: userId },
        data:  { isPremium: false },
      });

      await prisma.subscription.updateMany({
        where: { stripeSubId: sub.id },
        data:  { status: 'cancelled', plan: 'free' },
      });

      await prisma.notification.create({
        data: {
          userId,
          type:  'subscription_cancelled',
          title: 'Subscription Cancelled',
          body:  'Your VTRX Premium subscription has ended. You can resubscribe any time.',
        },
      });

      logger.info(`Subscription cancelled for user ${userId}`);
      break;
    }

    // ── Trial ending soon ───────────────────────────────────────────────────
    case 'customer.subscription.trial_will_end': {
      const sub    = event.data.object;
      const userId = sub.metadata?.userId;
      if (!userId) break;

      const trialEnd = new Date(sub.trial_end * 1000).toLocaleDateString();

      await prisma.notification.create({
        data: {
          userId,
          type:  'trial_ending',
          title: 'Free Trial Ending Soon',
          body:  `Your free trial ends on ${trialEnd}. Keep Premium to maintain full access.`,
        },
      });
      break;
    }

    default:
      logger.info(`Unhandled Stripe event: ${event.type}`);
  }

  // Mark as processed
  await prisma.stripeEvent.update({
    where: { id: event.id },
    data:  { processed: true },
  });

  return { received: true };
};

// ── Activate Premium ───────────────────────────────────────────────────────────
const activatePremium = async ({ userId, plan, stripeSubscriptionId }) => {
  // Get subscription details from Stripe
  const stripeSub = stripeSubscriptionId
    ? await stripe.subscriptions.retrieve(stripeSubscriptionId)
    : null;

  await prisma.$transaction([
    // Update user
    prisma.user.update({
      where: { id: userId },
      data:  { isPremium: true },
    }),
    // Update subscription record
    prisma.subscription.upsert({
      where:  { userId },
      create: {
        userId,
        plan,
        status:           'active',
        stripeSubId:      stripeSubscriptionId,
        currentPeriodEnd: stripeSub
          ? new Date(stripeSub.current_period_end * 1000)
          : null,
      },
      update: {
        plan,
        status:           'active',
        stripeSubId:      stripeSubscriptionId,
        currentPeriodEnd: stripeSub
          ? new Date(stripeSub.current_period_end * 1000)
          : null,
      },
    }),
    // Welcome notification
    prisma.notification.create({
      data: {
        userId,
        type:  'premium_activated',
        title: 'Welcome to VTRX Premium!',
        body:  'You now have full access to meal planning, unlimited recipe saves, AI coaching and more.',
      },
    }),
  ]);
};

// ── Get Subscription Status ────────────────────────────────────────────────────
const getSubscriptionStatus = async (userId) => {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
  });

  if (!sub || !sub.stripeSubId) {
    return { plan: 'free', status: 'inactive', isPremium: false };
  }

  // Verify with Stripe directly (always source of truth)
  try {
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubId);
    const isActive  = ['active', 'trialing'].includes(stripeSub.status);

    if (isActive !== (sub.status === 'active')) {
      // Sync our database with Stripe
      await prisma.subscription.update({
        where: { userId },
        data:  { status: isActive ? 'active' : 'inactive' },
      });
      await prisma.user.update({
        where: { id: userId },
        data:  { isPremium: isActive },
      });
    }

    return {
      plan:            sub.plan,
      status:          stripeSub.status,
      isPremium:       isActive,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtEnd:     stripeSub.cancel_at_period_end,
    };
  } catch (err) {
    logger.error('Stripe subscription check failed:', err.message);
    return { plan: sub.plan, status: sub.status, isPremium: sub.status === 'active' };
  }
};

module.exports = {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  getSubscriptionStatus,
  activatePremium,
};
