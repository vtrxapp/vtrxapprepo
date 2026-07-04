// ─────────────────────────────────────────────────────────────────────────────
// scripts/syncRecipesFromYmove.js — Populate the Recipe table from real ymove
// data, tagged to match our fixed category taxonomy (data/recipeCategories.js).
//
// Replaces the old hardcoded seedRecipes.js — recipes shown in the Discover
// tab's 11 category rows are now genuinely sourced from ymove instead of
// placeholder data. getCategorizedRecipes (nutritionController.js) still
// reads from the DB unchanged — only how that DB gets populated has changed.
//
// Runs on every server startup (server.js), but is cheap to re-run: each
// category is skipped once it already has CATEGORY_LIMIT recipes tagged, so
// redeploys only do live ymove fetching for categories that are still short.
// ─────────────────────────────────────────────────────────────────────────────

const prisma = require('../config/database');
const logger = require('../utils/logger');
const ymove  = require('../services/ymoveService');
const { TAGS, MEAL_TYPES, CATEGORY_LIMIT } = require('../data/recipeCategories');

// ymove has no dedicated "category" concept for most of these (confirmed via
// its API surface — only `diet` and `mealType` are structured filters), so
// several categories are approximated with keyword search + macro thresholds,
// same heuristic already used for personalised recipe tabs elsewhere in this
// controller. Multiple queries per category improve real-world coverage.
const TAG_QUERIES = [
  { tag: TAGS.HIGH_PROTEIN,  queries: [{ query: 'high protein', minProtein: 30 }, { query: 'protein' }] },
  { tag: TAGS.WEIGHT_LOSS,   queries: [{ query: 'weight loss', maxCalories: 500 }, { query: 'low calorie diet' }] },
  { tag: TAGS.MUSCLE_GAIN,   queries: [{ query: 'muscle building', minProtein: 25 }, { query: 'bulking' }] },
  { tag: TAGS.LOW_CALORIE,   queries: [{ query: 'low calorie', maxCalories: 400 }] },
  { tag: TAGS.VEGETARIAN,    queries: [{ diet: 'vegetarian' }] },
  { tag: TAGS.VEGAN,         queries: [{ diet: 'vegan' }] },
  { tag: TAGS.QUICK_MEAL,    queries: [{ query: 'quick easy meal' }, { query: '15 minute meal' }] },
  { tag: TAGS.HEALTHY_SNACK, queries: [{ query: 'healthy snack' }] },
];

const MEALTYPE_QUERIES = [
  { mealType: MEAL_TYPES.BREAKFAST, queries: [{ mealType: 'Breakfast' }, { query: 'breakfast' }] },
  { mealType: MEAL_TYPES.LUNCH,     queries: [{ mealType: 'Lunch' }, { query: 'lunch' }] },
  { mealType: MEAL_TYPES.DINNER,    queries: [{ mealType: 'Dinner' }, { query: 'dinner' }] },
];

// Normalises one raw ymove recipe object into Recipe-model fields (mirrors
// the extraction already used by the admin /ymove/sync-recipes endpoint).
function extractRecipeFields(r) {
  const rawId   = r.slug || (r.id != null ? r.id : r.ymoveId);
  const ymoveId = rawId != null ? String(rawId) : '';
  if (!ymoveId) return null;

  const rawDesc = r.description || r.desc || null;
  const description = rawDesc
    ? rawDesc
        .replace(/\[Adapted from Wikibooks[^\]]*\]/gi, '')
        .replace(/Adapted from Wikibooks[^.]*\./gi, '')
        .replace(/\(CC BY[^)]*\)/gi, '')
        .replace(/https?:\/\/[^\s]*wikibooks[^\s]*/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim() || null
    : null;

  const ingredients = Array.isArray(r.ingredients)
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

  return {
    ymoveId,
    name:        r.title || r.name || 'Recipe',
    calories:    parseInt(r.calories) || 0,
    protein:     parseFloat(r.protein) || 0,
    carbs:       parseFloat(r.carbs)   || 0,
    fat:         parseFloat(r.fat) || parseFloat(r.fats) || 0,
    prepTime:    parseInt(r.prepTimeMinutes || r.prepTime || r.prep_time || r.mins) || null,
    servings:    parseInt(r.servings) || 1,
    imageUrl:    r.imageUrl || r.image_url || r.img || null,
    description,
    ingredients,
    instructions,
  };
}

async function main() {
  if (!ymove.isConfigured()) {
    logger.info('Recipe sync skipped — YMOVE_API_KEY not configured');
    return { upserted: 0, removed: 0, skippedNoConfig: true };
  }

  // ymoveId -> { fields, tags:Set, mealType:string|null } — merged across all
  // queries so a recipe matched by more than one (e.g. a high-protein
  // breakfast) accumulates every tag/mealType it earns, instead of the last
  // write winning.
  const merged = new Map();

  const collectForQuery = async (queryParams, assign) => {
    let page = 1;
    let collectedNew = 0;
    const pageSize = 25;
    while (collectedNew < CATEGORY_LIMIT && page <= 6) {
      const { recipes } = await ymove.getRecipes({ ...queryParams, limit: pageSize, page });
      if (!recipes.length) break;
      for (const r of recipes) {
        const fields = extractRecipeFields(r);
        if (!fields) continue;
        let entry = merged.get(fields.ymoveId);
        const isNew = !entry;
        if (!entry) { entry = { fields, tags: new Set(), mealType: null }; merged.set(fields.ymoveId, entry); }
        else { entry.fields = fields; } // keep freshest field data
        assign(entry);
        if (isNew) collectedNew++;
      }
      if (recipes.length < pageSize) break;
      page++;
    }
    return collectedNew;
  };

  for (const { tag, queries } of TAG_QUERIES) {
    const existing = await prisma.recipe.count({ where: { tags: { has: tag } } });
    if (existing >= CATEGORY_LIMIT) continue; // already enough — skip live fetching
    let found = 0;
    for (const q of queries) {
      if (existing + found >= CATEGORY_LIMIT) break;
      found += await collectForQuery(q, entry => entry.tags.add(tag));
    }
    if (existing + found < CATEGORY_LIMIT) {
      logger.warn(`Recipe sync: only found ${existing + found}/${CATEGORY_LIMIT} for tag "${tag}"`);
    }
  }

  for (const { mealType, queries } of MEALTYPE_QUERIES) {
    const existing = await prisma.recipe.count({ where: { mealType } });
    if (existing >= CATEGORY_LIMIT) continue;
    let found = 0;
    for (const q of queries) {
      if (existing + found >= CATEGORY_LIMIT) break;
      found += await collectForQuery(q, entry => { if (!entry.mealType) entry.mealType = mealType; });
    }
    if (existing + found < CATEGORY_LIMIT) {
      logger.warn(`Recipe sync: only found ${existing + found}/${CATEGORY_LIMIT} for mealType "${mealType}"`);
    }
  }

  let upserted = 0;
  for (const [ymoveId, entry] of merged) {
    try {
      await prisma.recipe.upsert({
        where:  { ymoveId },
        update: { ...entry.fields, tags: [...entry.tags], mealType: entry.mealType },
        create: { ...entry.fields, tags: [...entry.tags], mealType: entry.mealType, isPublic: true },
      });
      upserted++;
    } catch (err) {
      logger.warn(`Recipe sync: skipping ${ymoveId} — ${err.message}`);
    }
  }

  // One-time (but safe to repeat) cleanup: remove the old hardcoded
  // placeholder recipes — they never had a ymoveId — now that categories are
  // backed by real ymove data.
  const removed = await prisma.recipe.deleteMany({ where: { ymoveId: null } });

  logger.info(`Recipe sync complete: ${upserted} recipe(s) upserted from ymove, ${removed.count} placeholder recipe(s) removed`);
  return { upserted, removed: removed.count };
}

const run = () => main();
module.exports = { run, main };

// Allow direct invocation: node scripts/syncRecipesFromYmove.js
if (require.main === module) {
  main().finally(() => prisma.$disconnect()).catch(e => { console.error(e); process.exit(1); });
}
