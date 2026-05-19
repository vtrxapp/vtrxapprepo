const express   = require('express');
const nutrition = require('../controllers/nutritionController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/recipes',             nutrition.getRecipes);
router.get('/recipes/:id',         nutrition.getRecipeById);
router.get('/saved',               nutrition.getSavedRecipes);
router.post('/saved',              nutrition.saveRecipe);
router.delete('/saved/:recipeId',  nutrition.unsaveRecipe);
router.get('/meal-plan',           nutrition.getMealPlan);

module.exports = router;
