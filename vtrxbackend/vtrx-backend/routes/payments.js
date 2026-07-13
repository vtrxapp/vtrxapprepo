// ─────────────────────────────────────────────────────────────────────────────
// routes/payments.js — Payment Routes
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const payment  = require('../controllers/paymentController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// ⚠ Webhook MUST use raw body — before express.json() middleware
// This route is registered in server.js BEFORE body parsing
router.post('/webhook', payment.webhook);

// All other routes need authentication
router.use(protect);

router.post('/create-checkout',           payment.createCheckout);
router.post('/create-subscription-intent', payment.createSubscriptionIntent);
router.post('/portal',                    payment.createPortal);
router.get('/status',                     payment.getStatus);
router.post('/verify-session',            payment.verifySession);
router.get('/methods',                    payment.getPaymentMethods);
router.get('/invoices',                   payment.getBillingHistory);

module.exports = router;
