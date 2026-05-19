// ─────────────────────────────────────────────────────────────────────────────
// controllers/nutritionController.js — Nutrition & Recipes Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma  = require('../config/database');
const ymove   = require('../services/ymoveService');
const logger  = require('../utils/logger');

// ── GET /api/nutrition/recipes — Browse recipes ───────────────────────────────
const getRecipes = async (req, res) => {
  const { tags, goal, search, limit = 20, offset = 0, source = 'all' } = req.query;

  try {
    // Build database query filters
    const where = {
      isPublic: true,
      ...(tags   && { tags: { hasSome: tags.split(',') } }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    };

    const [dbRecipes, total] = await Promise.all([
      prisma.recipe.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    parseInt(limit),
        skip:    parseInt(offset),
      }),
      prisma.recipe.count({ where }),
    ]);

    // Optionally fetch from Ymove
    let ymoveRecipes = [];
    if (source === 'ymove' || source === 'all') {
      const result = await ymove.getRecipes({ tags: tags?.split(','), goal });
      ymoveRecipes = result.recipes || [];
    }

    res.json({
      success: true,
      data: {
        recipes: [...dbRecipes, ...ymoveRecipes],
        total:   total + ymoveRecipes.length,
        hasMore: parseInt(offset) + parseInt(limit) < total,
      },
    });
  } catch (error) {
    logger.error('getRecipes error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recipes' });
  }
};

// ── GET /api/nutrition/recipes/:id ───────────────────────────────────────────
const getRecipeById = async (req, res) => {
  const { id } = req.params;

  try {
    let recipe = await prisma.recipe.findUnique({ where: { id } });

    // If not in our DB, try Ymove
    if (!recipe) {
      recipe = await ymove.getRecipeById(id);
    }

    if (!recipe) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }

    res.json({ success: true, data: { recipe } });
  } catch (error) {
    logger.error('getRecipeById error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recipe' });
  }
};

// ── POST /api/nutrition/saved — Save a recipe ─────────────────────────────────
const saveRecipe = async (req, res) => {
  const { recipeId } = req.body;

  try {
    // Free users: max 3 saved recipes
    if (!req.user.isPremium) {
      const count = await prisma.savedMeal.count({ where: { userId: req.user.id } });
      if (count >= 3) {
        return res.status(403).json({
          success: false,
          message: 'Free plan allows up to 3 saved recipes. Upgrade for unlimited.',
          code:    'SAVE_LIMIT_REACHED',
        });
      }
    }

    const saved = await prisma.savedMeal.create({
      data: { userId: req.user.id, recipeId },
    });

    res.status(201).json({ success: true, data: { saved } });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'Recipe already saved' });
    }
    logger.error('saveRecipe error:', error);
    res.status(500).json({ success: false, message: 'Failed to save recipe' });
  }
};

// ── DELETE /api/nutrition/saved/:recipeId — Unsave a recipe ──────────────────
const unsaveRecipe = async (req, res) => {
  const { recipeId } = req.params;

  try {
    await prisma.savedMeal.deleteMany({
      where: { userId: req.user.id, recipeId },
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('unsaveRecipe error:', error);
    res.status(500).json({ success: false, message: 'Failed to unsave recipe' });
  }
};

// ── GET /api/nutrition/saved — User's saved recipes ───────────────────────────
const getSavedRecipes = async (req, res) => {
  try {
    const saved = await prisma.savedMeal.findMany({
      where:   { userId: req.user.id },
      include: { recipe: true },
      orderBy: { savedAt: 'desc' },
    });

    res.json({
      success: true,
      data: { recipes: saved.map(s => s.recipe), count: saved.length },
    });
  } catch (error) {
    logger.error('getSavedRecipes error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch saved recipes' });
  }
};

// ── GET /api/nutrition/meal-plan — Today's meal plan (Premium) ────────────────
const getMealPlan = async (req, res) => {
  if (!req.user.isPremium) {
    return res.status(403).json({
      success: false,
      message: 'Meal planning requires Premium',
      code:    'PREMIUM_REQUIRED',
    });
  }

  try {
    // In future this will be AI-generated based on the user's goal
    // For now, return curated recipes for each meal slot
    const [breakfast, lunch, snack, dinner] = await Promise.all([
      prisma.recipe.findFirst({ where: { tags: { hasSome: ['Breakfast'] } } }),
      prisma.recipe.findFirst({ where: { tags: { hasSome: ['High Protein'] } } }),
      prisma.recipe.findFirst({ where: { tags: { hasSome: ['Snack'] } } }),
      prisma.recipe.findFirst({ where: { calories: { lte: 600 } } }),
    ]);

    const plan = [
      { time: 'Breakfast', recipe: breakfast },
      { time: 'Lunch',     recipe: lunch     },
      { time: 'Snack',     recipe: snack     },
      { time: 'Dinner',    recipe: dinner    },
    ].filter(p => p.recipe);

    res.json({ success: true, data: { plan } });
  } catch (error) {
    logger.error('getMealPlan error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch meal plan' });
  }
};

module.exports = {
  getRecipes,
  getRecipeById,
  saveRecipe,
  unsaveRecipe,
  getSavedRecipes,
  getMealPlan,
};
