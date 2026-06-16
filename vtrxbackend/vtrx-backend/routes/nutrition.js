const express   = require('express');
const nutrition = require('../controllers/nutritionController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.post('/ymove/sync-recipes',  nutrition.syncYmoveRecipes);   // POST /nutrition/ymove/sync-recipes
router.get('/recipes',             nutrition.getRecipes);
router.get('/recipes/:id',         nutrition.getRecipeById);
router.get('/saved',               nutrition.getSavedRecipes);
router.post('/saved',              nutrition.saveRecipe);
router.delete('/saved/:recipeId',  nutrition.unsaveRecipe);
router.get('/meal-plan',           nutrition.getMealPlan);
router.get('/foods',               nutrition.getFoods);             // GET /nutrition/foods?query=chicken
router.get('/foods/:id',           nutrition.getFoodById);          // GET /nutrition/foods/:id
router.post('/analyze',            nutrition.analyzeMeal);          // POST /nutrition/analyze

module.exports = router;
