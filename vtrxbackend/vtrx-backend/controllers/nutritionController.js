// ─────────────────────────────────────────────────────────────────────────────
// controllers/nutritionController.js — Nutrition & Recipes Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma    = require('../config/database');
const ymove     = require('../services/ymoveService');
const aiService = require('../services/aiService');
const logger    = require('../utils/logger');

// ── GET /api/nutrition/recipes — Browse recipes ───────────────────────────────
// Supports source=ymove (live paginated) or source=db (DB only) or source=all
const getRecipes = async (req, res) => {
  const { query, diet, cuisine, mealType, maxCalories, minProtein, search,
          limit = 20, page = 1, source = 'ymove' } = req.query;
  const pageNum = parseInt(page) || 1;
  const pageSize = parseInt(limit) || 20;

  try {
    const searchTerm = query || search;

    // ── ymove source: fully paginated through ymove API ──────────────────────
    if (source === 'ymove') {
      const result = await ymove.getRecipes({
        query: searchTerm, diet, cuisine, mealType, maxCalories, minProtein,
        limit: pageSize, page: pageNum,
      });
      return res.json({
        success: true,
        data: {
          recipes: result.recipes || [],
          total:   result.total   || 0,
          hasMore: pageNum * pageSize < (result.total || 0),
          page:    pageNum,
        },
      });
    }

    // ── DB source or all: paginate from our DB ─────────────────────────────
    const dietArray = diet ? diet.split(',') : undefined;
    const where = {
      isPublic: true,
      ...(dietArray  && { tags: { hasSome: dietArray } }),
      ...(searchTerm && { name: { contains: searchTerm, mode: 'insensitive' } }),
    };
    const offset = (pageNum - 1) * pageSize;

    const [dbRecipes, total] = await Promise.all([
      prisma.recipe.findMany({ where, orderBy: { createdAt: 'desc' }, take: pageSize, skip: offset }),
      prisma.recipe.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        recipes: dbRecipes,
        total,
        hasMore: offset + pageSize < total,
        page:    pageNum,
      },
    });
  } catch (error) {
    logger.error('getRecipes error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recipes' });
  }
};

// ── In-memory cache for personalised recipe responses ────────────────────────
const _recipeCache    = new Map();
const RECIPE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── GET /api/nutrition/recipes/personalised ───────────────────────────────────
// Returns ≤10 recipes tailored to the user's dietary restrictions + goal.
// Tab values: all | high_protein | low_carb | vegan | vegetarian
const getPersonalisedRecipes = async (req, res) => {
  const { tab = 'all' } = req.query;
  const userId = req.user.id;

  try {
    // 1. Load user profile
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { dietaryRestrictions: true, nutritionGoal: true, goal: true },
    });
    const restrictions  = user?.dietaryRestrictions || [];
    const nutritionGoal = user?.nutritionGoal || '';
    const primaryGoal   = user?.goal          || '';

    // 2. Cache lookup
    const cacheKey = `r_${userId}_${tab}_${[...restrictions].sort().join(',')}`;
    const hit = _recipeCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      return res.json({ success: true, data: hit.data, fromCache: true });
    }

    // 3. Build ymove query params — base dietary filter first
    const params = { limit: 10, page: 1 };
    if      (restrictions.includes('vegan'))       params.diet = 'vegan';
    else if (restrictions.includes('vegetarian'))  params.diet = 'vegetarian';
    else if (restrictions.includes('gluten_free')) params.diet = 'gluten-free';
    else if (restrictions.includes('dairy_free'))  params.diet = 'dairy-free';

    const isVegan       = restrictions.includes('vegan');
    const isVeg         = restrictions.includes('vegetarian');
    const isLoseFat     = nutritionGoal === 'lose_fat'     || primaryGoal === 'lose_weight';
    const isBuildMuscle = nutritionGoal === 'build_muscle' || primaryGoal === 'build_muscle';

    // 4. Tab-specific overrides
    switch (tab) {
      case 'all':
        if (isLoseFat)                           { params.maxCalories = 500; params.minProtein = 20; }
        else if (isBuildMuscle)                  { params.minProtein = 30; }
        else if (nutritionGoal === 'eat_clean')  { params.query = 'whole food'; }
        else if (nutritionGoal === 'improve_energy') { params.query = 'complex carbs'; }
        break;
      case 'high_protein':
        if (isVegan)    { params.query = 'high protein vegan';        params.minProtein = 15; }
        else if (isVeg) { params.query = 'high protein vegetarian';   params.minProtein = 20; }
        else            { params.query = 'high protein';               params.minProtein = 30; }
        break;
      case 'low_carb':
        params.query = isVegan ? 'low carb vegan' : isVeg ? 'low carb vegetarian' : 'low carb';
        break;
      case 'vegan':
        params.diet  = 'vegan';
        params.query = isBuildMuscle ? 'vegan high protein' : isLoseFat ? 'vegan low calorie' : 'vegan';
        if (isLoseFat) params.maxCalories = 400;
        break;
      case 'vegetarian':
        params.diet  = 'vegetarian';
        params.query = isBuildMuscle ? 'vegetarian high protein' : isLoseFat ? 'vegetarian low calorie' : 'vegetarian';
        if (isLoseFat) params.maxCalories = 400;
        break;
      default: break;
    }

    if (restrictions.includes('no_peanuts')) {
      params.query = (params.query ? params.query + ' -peanut' : '-peanut').trim();
    }

    // 5. Call ymove
    const result  = await ymove.getRecipes(params);
    const recipes = result.recipes || [];

    logger.info(`[personalised-recipes] userId=${userId} tab=${tab} diet=${params.diet||'none'} query="${params.query||''}" → ${recipes.length} results`);

    // 6. Cache + return
    const responseData = { recipes, total: recipes.length, tab };
    _recipeCache.set(cacheKey, { data: responseData, expiresAt: Date.now() + RECIPE_CACHE_TTL });
    res.json({ success: true, data: responseData });
  } catch (error) {
    logger.error('getPersonalisedRecipes error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch personalised recipes' });
  }
};

// ── GET /api/nutrition/recipes/:id ───────────────────────────────────────────
const getRecipeById = async (req, res) => {
  const { id } = req.params;

  try {
    let recipe = await prisma.recipe.findUnique({ where: { id } });

    // If not in our DB, try ymove directly (id may be a ymoveId/slug)
    if (!recipe) {
      recipe = await ymove.getRecipeById(id);
    }

    if (!recipe) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }

    // DB recipes from the sync often lack instructions (search endpoint omits them).
    // Fetch the full detail from ymove if instructions are missing and we have a ymoveId.
    const hasInstructions = Array.isArray(recipe.instructions)
      ? recipe.instructions.length > 0
      : !!recipe.instructions;

    if (!hasInstructions && recipe.ymoveId) {
      const fresh = await ymove.getRecipeById(recipe.ymoveId);
      if (fresh) {
        const freshInstructions = Array.isArray(fresh.instructions)
          ? fresh.instructions
          : typeof fresh.instructions === 'string'
            ? [fresh.instructions]
            : [];
        // Strip Wikibooks attribution from description
        const cleanDesc = (s) => s
          ? s.replace(/\[Adapted from Wikibooks[^\]]*\]/gi, '')
             .replace(/Adapted from Wikibooks[^.]*\./gi, '')
             .replace(/\(CC BY[^)]*\)/gi, '')
             .replace(/https?:\/\/[^\s]*wikibooks[^\s]*/gi, '')
             .replace(/\s{2,}/g, ' ')
             .trim()
          : s;

        // Merge fresh data onto the DB record and persist for future requests
        recipe = {
          ...recipe,
          instructions: freshInstructions.length > 0 ? freshInstructions : recipe.instructions,
          description:  cleanDesc(fresh.description || recipe.description),
        };
        // Back-fill instructions in DB so next request is instant
        if (freshInstructions.length > 0) {
          prisma.recipe.update({
            where: { id: recipe.id },
            data:  {
              instructions: freshInstructions,
              description:  recipe.description,
            },
          }).catch(() => {});
        }
      }
    }

    // Always clean the description before returning
    if (recipe.description) {
      recipe = {
        ...recipe,
        description: recipe.description
          .replace(/\[Adapted from Wikibooks[^\]]*\]/gi, '')
          .replace(/Adapted from Wikibooks[^.]*\./gi, '')
          .replace(/\(CC BY[^)]*\)/gi, '')
          .replace(/https?:\/\/[^\s]*wikibooks[^\s]*/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim(),
      };
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
  const adminIds     = (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean);
  const adminSecret  = process.env.ADMIN_SECRET;
  const secretHeader = req.headers['x-admin-secret'];
  const isAdmin = req.user?.isAdmin
    || adminIds.includes(req.user?.id)
    || (adminSecret && secretHeader === adminSecret);
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
        // Prefer slug (human-readable, matches GET /recipes/:slug) over numeric id
        const rawId   = r.slug || (r.id != null ? r.id : r.ymoveId);
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
        const rawDesc      = r.description || r.desc || null;
        const description  = rawDesc
          ? rawDesc
              .replace(/\[Adapted from Wikibooks[^\]]*\]/gi, '')
              .replace(/Adapted from Wikibooks[^.]*\./gi, '')
              .replace(/\(CC BY[^)]*\)/gi, '')
              .replace(/https?:\/\/[^\s]*wikibooks[^\s]*/gi, '')
              .replace(/\s{2,}/g, ' ')
              .trim() || null
          : null;
        // ingredients may be objects (ymove uses quantity/unit/name) or plain strings
        const ingredients  = Array.isArray(r.ingredients)
          ? r.ingredients.map(i => {
              if (typeof i === 'string') return i;
              const qty  = i.amount ?? i.quantity ?? i.qty ?? '';
              const unit = i.unit ?? i.measure ?? '';
              const name = i.name ?? i.ingredient ?? i.item ?? '';
              const qStr = qty !== '' && qty !== 0 ? String(qty) : '';
              return [qStr, unit, name].filter(Boolean).join(' ');
            }).filter(Boolean)
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
  getPersonalisedRecipes,
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
