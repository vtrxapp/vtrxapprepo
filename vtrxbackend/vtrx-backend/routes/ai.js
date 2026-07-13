// routes/ai.js
const express = require('express');
const ai      = require('../controllers/aiController');
const { protect, requirePremium } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.post('/mood-recommendation', ai.getMoodRecommendation);
router.get('/weekly-insight',       ai.getWeeklyInsight);
router.post('/nutrition-advice',    ai.getNutritionAdvice);
router.post('/recovery',            ai.getRecoveryAdvice);
router.post('/workout-plan',        requirePremium, ai.generatePlan); // Premium only

router.post('/onboarding-analysis', ai.generateOnboardingAnalysis);
router.get('/onboarding-analysis',  ai.getOnboardingAnalysis);

module.exports = router;
