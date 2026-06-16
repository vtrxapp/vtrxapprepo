const express   = require('express');
const nutrition = require('../controllers/nutritionController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

// ── Ymove admin sync ──────────────────────────────────────────────────────────
router.post('/ymove/sync-recipes',       nutrition.syncYmoveRecipes);

// ── Recipes — static paths must come before /:id ─────────────────────────────
router.get('/recipes/diets',             nutrition.getRecipeDiets);       // GET /nutrition/recipes/diets
router.get('/recipes/meal-types',        nutrition.getRecipeMealTypes);   // GET /nutrition/recipes/meal-types
router.get('/recipes',                   nutrition.getRecipes);
router.get('/recipes/:id',               nutrition.getRecipeById);

// ── Saved recipes ─────────────────────────────────────────────────────────────
router.get('/saved',                     nutrition.getSavedRecipes);
router.post('/saved',                    nutrition.saveRecipe);
router.delete('/saved/:recipeId',        nutrition.unsaveRecipe);

// ── Meal plans ────────────────────────────────────────────────────────────────
router.get('/meal-plan',                 nutrition.getMealPlan);           // AI-generated (Claude)
router.get('/mealplans/generate',        nutrition.generateYmoveMealPlan); // ymove recipe-based

// ── Food database ─────────────────────────────────────────────────────────────
router.get('/foods',                     nutrition.getFoods);              // GET /nutrition/foods?query=chicken
router.get('/foods/:id',                 nutrition.getFoodById);           // GET /nutrition/foods/:id

// ── AI meal text analysis ─────────────────────────────────────────────────────
router.post('/analyze',                  nutrition.analyzeMeal);           // POST /nutrition/analyze

module.exports = router;
