const express   = require('express');
const nutrition = require('../controllers/nutritionController');
const plan      = require('../controllers/nutritionPlanController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// ── Ymove admin sync ──────────────────────────────────────────────────────────
router.post('/ymove/sync-recipes',       nutrition.syncYmoveRecipes);

// ── Recipes — static paths must come before /:id ─────────────────────────────
router.get('/recipes/diets',             nutrition.getRecipeDiets);          // GET /nutrition/recipes/diets
router.get('/recipes/meal-types',        nutrition.getRecipeMealTypes);      // GET /nutrition/recipes/meal-types
router.get('/recipes/personalised',      nutrition.getPersonalisedRecipes);  // GET /nutrition/recipes/personalised?tab=all|high_protein|low_carb|vegan|vegetarian
router.get('/recipes',                   nutrition.getRecipes);
router.get('/recipes/:id',               nutrition.getRecipeById);

// ── Saved recipes ─────────────────────────────────────────────────────────────
router.get('/saved',                     nutrition.getSavedRecipes);
router.post('/saved',                    nutrition.saveRecipe);
router.delete('/saved/:recipeId',        nutrition.unsaveRecipe);

// ── AI Nutrition Plan (Claude-powered) ───────────────────────────────────────
router.post('/generate-plan',            plan.generateNutritionPlan);      // POST — generate + save 7-day plan
router.get('/active-plan',               plan.getActiveNutritionPlan);     // GET  — fetch current active plan
router.post('/food-log',                 plan.logFood);                    // POST — log a meal
router.get('/food-log/today',            plan.getTodayFoodLogs);           // GET  — today's logged meals

// ── Legacy meal plans ─────────────────────────────────────────────────────────
router.get('/meal-plan',                 nutrition.getMealPlan);           // AI-generated (legacy)
router.get('/mealplans/generate',        nutrition.generateYmoveMealPlan); // ymove recipe-based

// ── Food database ─────────────────────────────────────────────────────────────
router.get('/foods',                     nutrition.getFoods);              // GET /nutrition/foods?query=chicken
router.get('/foods/:id',                 nutrition.getFoodById);           // GET /nutrition/foods/:id

// ── AI meal text analysis ─────────────────────────────────────────────────────
router.post('/analyze',                  nutrition.analyzeMeal);           // POST /nutrition/analyze

module.exports = router;
