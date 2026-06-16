// ─────────────────────────────────────────────────────────────────────────────
// controllers/nutritionController.js — Nutrition & Recipes Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma    = require('../config/database');
const ymove     = require('../services/ymoveService');
const aiService = require('../services/aiService');
const logger    = require('../utils/logger');

// ── GET /api/nutrition/recipes — Browse recipes ───────────────────────────────
// ymove params: query, diet, cuisine, mealType, maxCalories, minProtein, page, pageSize
const getRecipes = async (req, res) => {
  const { query, diet, cuisine, mealType, maxCalories, minProtein, search, limit = 20, offset = 0, source = 'all' } = req.query;

  try {
    const searchTerm = query || search;
    const dietArray  = diet ? diet.split(',') : undefined;

    // Build database query filters
    const where = {
      isPublic: true,
      ...(dietArray  && { tags: { hasSome: dietArray } }),
      ...(searchTerm && { name: { contains: searchTerm, mode: 'insensitive' } }),
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

    // Optionally fetch live from ymove
    let ymoveRecipes = [];
    if (source === 'ymove' || source === 'all') {
      const result = await ymove.getRecipes({ query: searchTerm, diet, cuisine, mealType, maxCalories, minProtein });
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

// ── GET /api/nutrition/meal-plan — Today's AI-generated meal plan (Premium) ───
const getMealPlan = async (req, res) => {
  if (!req.user.isPremium) {
    return res.status(403).json({
      success: false,
      message: 'Meal planning requires Premium',
      code:    'PREMIUM_REQUIRED',
    });
  }

  try {
    const [user, todayLog] = await Promise.all([
      prisma.user.findUnique({
        where:  { id: req.user.id },
        select: { goal: true, weight: true, fitnessLevel: true },
      }),
      prisma.workoutLog.findFirst({
        where: {
          userId:      req.user.id,
          completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
        select: { name: true, caloriesBurned: true },
      }),
    ]);

    const { mealPlan, tokensUsed } = await aiService.generateMealPlan({
      goal:           user?.goal,
      weight:         user?.weight,
      fitnessLevel:   user?.fitnessLevel,
      todayWorkout:   todayLog?.name,
      caloriesBurned: todayLog?.caloriesBurned,
    });

    res.json({ success: true, data: { plan: mealPlan, tokensUsed } });
  } catch (error) {
    logger.error('getMealPlan error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate meal plan' });
  }
};

// ── POST /api/nutrition/ymove/sync-recipes ───────────────────────────────────
// Admin-only: fetches all ymove recipes and upserts into the Recipe table.
const syncYmoveRecipes = async (req, res) => {
  if (!ymove.isConfigured()) {
    return res.status(503).json({ success: false, message: 'YMOVE_API_KEY not configured' });
  }
  const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean);
  const isAdmin  = req.user?.isAdmin || adminIds.includes(req.user?.id);
  if (!isAdmin) {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }

  try {
    let page = 1;
    const pageSize = 100;
    let fetchedTotal = null;
    let upserted = 0;
    let skipped  = 0;

    while (true) {
      const { recipes, total: t } = await ymove.getRecipes({ limit: pageSize, page });
      if (!recipes.length) break;

      if (fetchedTotal === null) fetchedTotal = t > 0 ? t : null;

      for (const r of recipes) {
        const rawId   = r.id != null ? r.id : r.ymoveId;
        const ymoveId = rawId != null ? String(rawId) : '';
        if (!ymoveId) { skipped++; continue; }

        const name         = r.title || r.name || 'Recipe';
        const calories     = parseInt(r.calories) || 0;
        const protein      = parseFloat(r.protein) || 0;
        const carbs        = parseFloat(r.carbs)   || 0;
        const fat          = parseFloat(r.fat) || parseFloat(r.fats) || 0;
        // ymove uses prepTimeMinutes (docs confirmed); fall back to legacy field names
        const prepTime     = parseInt(r.prepTimeMinutes || r.prepTime || r.prep_time || r.mins) || null;
        const servings     = parseInt(r.servings) || 1;
        const imageUrl     = r.imageUrl || r.image_url || r.img || null;
        // ymove uses 'diet' (array) for dietary tags; fall back to 'tags'
        const tags         = Array.isArray(r.diet) ? r.diet : (Array.isArray(r.tags) ? r.tags : (r.tags ? [r.tags] : []));
        const description  = r.description || r.desc || null;
        // ingredients may be objects { name, amount } (from /recipes/:id) or strings
        const ingredients  = Array.isArray(r.ingredients)
          ? r.ingredients.map(i => typeof i === 'string' ? i : `${i.amount ? i.amount + ' ' : ''}${i.name || ''}`.trim())
          : [];
        const instructions = Array.isArray(r.instructions) ? r.instructions
          : (typeof r.instructions === 'string' ? [r.instructions] : []);

        try {
          await prisma.recipe.upsert({
            where:  { ymoveId },
            update: { name, calories, protein, carbs, fat, prepTime, servings, imageUrl, tags, description, ingredients, instructions },
            create: { name, calories, protein, carbs, fat, prepTime, servings, imageUrl, tags, description, ingredients, instructions, ymoveId, isPublic: true },
          });
          upserted++;
        } catch (err) {
          logger.warn(`ymove recipe sync: skipping ${ymoveId} — ${err.message}`);
          skipped++;
        }
      }

      const fetched = page * pageSize;
      if (recipes.length < pageSize || (fetchedTotal !== null && fetched >= fetchedTotal)) break;
      page++;
    }

    logger.info(`ymove recipe sync complete: ${upserted} upserted, ${skipped} skipped`);
    res.json({ success: true, data: { synced: upserted, skipped } });
  } catch (error) {
    logger.error('syncYmoveRecipes error:', error);
    res.status(500).json({ success: false, message: 'Recipe sync failed' });
  }
};

// ── GET /api/nutrition/foods — Search food database ───────────────────────────
// params: query (required), source, usdaOnly, country, per, page, pageSize
const getFoods = async (req, res) => {
  const { query, source, usdaOnly, country, per, limit = 20, page = 1 } = req.query;
  if (!query) {
    return res.status(400).json({ success: false, message: 'query is required' });
  }
  try {
    const result = await ymove.getFoods({
      query, source,
      usdaOnly: usdaOnly === 'true' ? true : usdaOnly === 'false' ? false : undefined,
      country, per,
      limit: parseInt(limit), page: parseInt(page),
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('getFoods error:', error);
    res.status(500).json({ success: false, message: 'Failed to search foods' });
  }
};

// ── GET /api/nutrition/foods/:id — Single food item ───────────────────────────
const getFoodById = async (req, res) => {
  const { id } = req.params;
  try {
    const food = await ymove.getFoodById(id);
    if (!food) return res.status(404).json({ success: false, message: 'Food not found' });
    res.json({ success: true, data: { food } });
  } catch (error) {
    logger.error('getFoodById error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch food' });
  }
};

// ── POST /api/nutrition/analyze — AI meal text analysis ───────────────────────
// body: { text: "grilled chicken with rice and broccoli" }
// Returns per-food breakdown + totals; counts toward ymove monthly analysis cap
const analyzeMeal = async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ success: false, message: 'text is required' });
  }
  try {
    const result = await ymove.analyzeMeal(text);
    if (!result) return res.status(503).json({ success: false, message: 'Meal analysis unavailable' });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('analyzeMeal error:', error);
    res.status(500).json({ success: false, message: 'Failed to analyze meal' });
  }
};

// ── GET /api/nutrition/recipes/diets — Available diet types ───────────────────
const getRecipeDiets = async (_req, res) => {
  try {
    const diets = await ymove.getRecipeDiets();
    res.json({ success: true, data: diets });
  } catch (error) {
    logger.error('getRecipeDiets error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch diet types' });
  }
};

// ── GET /api/nutrition/recipes/meal-types — Available meal types ───────────────
const getRecipeMealTypes = async (_req, res) => {
  try {
    const types = await ymove.getRecipeMealTypes();
    res.json({ success: true, data: types });
  } catch (error) {
    logger.error('getRecipeMealTypes error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch meal types' });
  }
};

// ── GET /api/nutrition/mealplans/generate — ymove recipe-based meal plan ───────
// params: calories* (required), diet, meals, days, macroSplit
// Distinct from /meal-plan which uses Claude AI for free-form suggestions
const generateYmoveMealPlan = async (req, res) => {
  const { calories, diet, meals, days, macroSplit } = req.query;
  if (!calories) {
    return res.status(400).json({ success: false, message: 'calories is required' });
  }
  try {
    const result = await ymove.generateYmoveMealPlan({
      calories: parseInt(calories),
      diet,
      meals:      meals ? parseInt(meals) : undefined,
      days:       days  ? parseInt(days)  : 1,
      macroSplit,
    });
    if (!result) return res.status(503).json({ success: false, message: 'Meal plan generation unavailable' });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('generateYmoveMealPlan error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate meal plan' });
  }
};

module.exports = {
  getRecipes,
  getRecipeById,
  getRecipeDiets,
  getRecipeMealTypes,
  saveRecipe,
  unsaveRecipe,
  getSavedRecipes,
  getMealPlan,
  generateYmoveMealPlan,
  syncYmoveRecipes,
  getFoods,
  getFoodById,
  analyzeMeal,
};
