// ─────────────────────────────────────────────────────────────────────────────
// services/nutritionPlanService.js — AI Nutrition Plan Generator
// ─────────────────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('../utils/logger');
const ymove     = require('./ymoveService');

// ── Lazy Anthropic client (same singleton as workoutPlanService) ──────────────
let anthropic = null;
const getClient = () => {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { logger.warn('ANTHROPIC_API_KEY not set'); return null; }
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
};

// ── Height string → cm ────────────────────────────────────────────────────────
const parseHeightToCm = (heightStr) => {
  if (!heightStr) return 170;
  // "5'10"" or "5'10"
  const feetInches = String(heightStr).match(/(\d+)['''`](\d+)/);
  if (feetInches) return ((parseInt(feetInches[1]) * 12) + parseInt(feetInches[2])) * 2.54;
  // "178cm" or "178"
  const cm = String(heightStr).match(/^(\d{3})/);
  if (cm) return parseInt(cm[1]);
  // "5.8" decimal feet
  const decFt = String(heightStr).match(/^(\d+\.?\d*)/);
  if (decFt) return parseFloat(decFt[1]) * 30.48;
  return 170;
};

// ── Height cm → ft display string ────────────────────────────────────────────
const cmToFtDisplay = (cm) => {
  const inches = cm / 2.54;
  const ft     = Math.floor(inches / 12);
  const inch   = Math.round(inches % 12);
  return `${ft}'${inch}"`;
};

// ── BMR — Mifflin-St Jeor ────────────────────────────────────────────────────
const calcBMR = (weightKg, heightCm, age, gender) => {
  const base = (10 * weightKg) + (6.25 * heightCm) - (5 * (age || 30));
  const isFemale = (gender || '').toLowerCase().includes('female') || gender === 'F';
  return Math.round(isFemale ? base - 161 : base + 5);
};

// ── TDEE — activity multiplier by workout frequency ───────────────────────────
const calcTDEE = (bmr, daysPerWeek) => {
  const days = parseInt(daysPerWeek) || 0;
  const mult = days >= 5 ? 1.725 : days >= 3 ? 1.55 : days >= 1 ? 1.375 : 1.2;
  return Math.round(bmr * mult);
};

// ── Calorie target by nutrition goal ─────────────────────────────────────────
const calcCalorieTarget = (tdee, nutritionGoal, gender) => {
  const adjustments = {
    lose_fat:       -500,
    build_muscle:   +300,
    maintain:          0,
    eat_clean:         0,
    improve_energy:  +100,
  };
  const adj = adjustments[nutritionGoal] ?? 0;
  const raw = tdee + adj;
  const isFemale = (gender || '').toLowerCase().includes('female');
  const minCal   = isFemale ? 1200 : 1500;
  return Math.round(Math.max(minCal, Math.min(tdee + 500, raw)));
};

// ── Macro targets ─────────────────────────────────────────────────────────────
const calcMacros = (calorieTarget, weightKg, nutritionGoal) => {
  const proteinRatio = { lose_fat:2.2, build_muscle:2.0, maintain:1.6, eat_clean:1.8, improve_energy:1.6 };
  const fatPct       = { lose_fat:0.25, build_muscle:0.30, maintain:0.30, eat_clean:0.35, improve_energy:0.25 };

  const proteinG = Math.round((proteinRatio[nutritionGoal] || 1.6) * weightKg);
  const fatG     = Math.round(calorieTarget * (fatPct[nutritionGoal] || 0.30) / 9);
  const carbG    = Math.round(Math.max(0, calorieTarget - (proteinG * 4) - (fatG * 9)) / 4);

  return { proteinG, fatG, carbG };
};

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are VTRX's AI nutrition coach. You create practical, sustainable meal plans that fit each user's exact calorie and macro targets, dietary restrictions, and lifestyle. Every meal plan must be realistic — real foods people actually eat, not complicated recipes requiring hours of prep.

You respond ONLY in valid JSON. No markdown, no explanation, just the JSON object.`;

// ── Build the user prompt ────────────────────────────────────────────────────
const buildPrompt = (user, calcs) => {
  const { bmr, tdee, calorieTarget, proteinG, carbG, fatG } = calcs;
  const weightKg  = Math.round((user.weight || 150) * 0.453592 * 10) / 10;
  const heightCm  = parseHeightToCm(user.height);
  const heightFt  = cmToFtDisplay(heightCm);
  const goal      = user.nutritionGoal   || 'maintain';
  const tracking  = user.trackingPreference || 'no_not_interested';
  const diets     = (user.dietaryRestrictions || []);
  const mealsDay  = user.mealsPerDay     || '3';
  const gender    = user.gender          || 'prefer_not_to_say';
  const name      = user.name ? user.name.split(' ')[0] : null;

  const dietRulesBlock = [
    diets.includes('vegan') && `
If vegan:
- ZERO animal products whatsoever
- Protein sources: tofu, tempeh, lentils, chickpeas, black beans, edamame, seitan, hemp seeds, quinoa, nutritional yeast
- No eggs, no dairy, no meat, no fish, no honey`,
    diets.includes('vegetarian') && !diets.includes('vegan') && `
If vegetarian:
- No meat or fish
- Eggs and dairy allowed
- Protein sources: eggs, Greek yogurt, cottage cheese, paneer, legumes, tofu`,
    diets.includes('gluten_free') && `
If gluten_free:
- No wheat, barley, rye, regular oats
- Allowed: rice, quinoa, potatoes, gluten-free oats, corn, sweet potato
- Check sauces and seasonings for hidden gluten`,
    diets.includes('dairy_free') && `
If dairy_free:
- No milk, cheese, yogurt, butter, cream
- Dairy alternatives allowed: oat milk, almond milk, coconut yogurt, dairy-free cheese`,
    diets.includes('no_peanuts') && `
If no_peanuts:
- Zero peanuts or peanut products
- Nut butters allowed: almond, cashew, sunflower seed butter only`,
  ].filter(Boolean).join('\n') || '- No dietary restrictions — include all food groups';

  const mealFreqBlock = {
    '2': `2 meals/day:\n- Larger portions per meal\n- Include substantial snacks\n- Label as: Meal 1 (late morning), Meal 2 (evening)`,
    '3': `3 meals/day:\n- Standard breakfast, lunch, dinner\n- One optional snack if calories allow`,
    '4_plus': `4+ meals/day:\n- Breakfast, lunch, dinner + 1-2 snacks\n- Smaller portions per meal`,
    'varies': `It varies:\n- Create 3 main meals + 2 flexible snacks\n- Note which can be skipped on lower appetite days`,
  }[mealsDay] || `3 meals/day:\n- Standard breakfast, lunch, dinner`;

  const goalFoodBlock = {
    lose_fat:       `- High volume, low calorie foods first\n- Avoid liquid calories\n- Complex carbs only (oats, brown rice, sweet potato, quinoa)\n- No added sugars\n- Fill 50% of plate with vegetables`,
    build_muscle:   `- Prioritise protein at every meal\n- Include carbs around workouts\n- Healthy caloric density foods\n- Include calorie-dense snacks if needed (nuts, nut butter, avocado)`,
    maintain:       `- Balanced macros each meal\n- Wide variety of foods\n- Focus on consistency over perfection`,
    eat_clean:      `- Only whole, unprocessed foods\n- No refined sugars, no processed meats\n- Every ingredient should be recognisable`,
    improve_energy: `- Complex carbs at every meal\n- Include iron-rich foods (spinach, lentils, lean red meat if not vegan)\n- B12 sources (eggs, fish, fortified foods)\n- Avoid sugar crashes — no simple sugars alone`,
  }[goal] || '';

  return `Create a 7-day meal plan for this user:

PHYSICAL PROFILE:
- Age: ${user.age || 30}
- Sex: ${gender}
- Weight: ${user.weight || 150} lbs (${weightKg} kg)
- Height: ${heightFt}
${user.bodyFatPercentage ? `- Body fat: ${user.bodyFatPercentage}%` : ''}
${user.goalWeightLbs ? `- Goal weight: ${user.goalWeightLbs} lbs` : ''}

CALCULATED TARGETS (use these exact numbers):
- BMR: ${bmr} calories
- TDEE: ${tdee} calories
- Daily calorie target: ${calorieTarget} calories
- Daily protein target: ${proteinG}g
- Daily carb target: ${carbG}g
- Daily fat target: ${fatG}g

PREFERENCES:
- Nutrition goal: ${goal}
- Tracking preference: ${tracking}
- Meals per day: ${mealsDay}
- Dietary restrictions: ${diets.length ? diets.join(', ') : 'none'}
- Workout goal: ${user.goal || 'general fitness'}

STRICT DIETARY RULES — APPLY TO EVERY MEAL:
${dietRulesBlock}

MEAL FREQUENCY RULES:
${mealFreqBlock}

GOAL-SPECIFIC FOOD RULES:
${goalFoodBlock}

PRACTICALITY RULES:
- Maximum 20 minutes prep time per meal
- Use common supermarket ingredients only
- Each meal should require 5 ingredients or fewer
- Include meal prep batching suggestions
- At least 3 meals per week should be repeatable from previous days

RESPOND WITH THIS EXACT JSON STRUCTURE:
{
  "plan_name": "string",
  "plan_summary": "string (max 40 words)",
  "daily_targets": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number,
    "water_ml": number
  },
  "shopping_list": {
    "proteins": ["string"],
    "carbs": ["string"],
    "vegetables": ["string"],
    "healthy_fats": ["string"],
    "pantry": ["string"],
    "snacks": ["string"]
  },
  "meal_prep_tips": ["string"],
  "week": {
    "monday": {
      "day_total_calories": number,
      "day_total_protein_g": number,
      "meals": [
        {
          "meal_name": "string",
          "meal_time_suggestion": "string",
          "recipe_name": "string",
          "calories": number,
          "protein_g": number,
          "carbs_g": number,
          "fat_g": number,
          "ingredients": [{ "item": "string", "amount": "string", "unit": "string" }],
          "instructions": "string",
          "prep_time_mins": number,
          "ymove_recipe_search_term": "string",
          "meal_prep_note": "string"
        }
      ]
    },
    "tuesday":   { "day_total_calories": number, "day_total_protein_g": number, "meals": [] },
    "wednesday": { "day_total_calories": number, "day_total_protein_g": number, "meals": [] },
    "thursday":  { "day_total_calories": number, "day_total_protein_g": number, "meals": [] },
    "friday":    { "day_total_calories": number, "day_total_protein_g": number, "meals": [] },
    "saturday":  { "day_total_calories": number, "day_total_protein_g": number, "meals": [] },
    "sunday":    { "day_total_calories": number, "day_total_protein_g": number, "meals": [] }
  },
  "supplement_suggestions": [{ "supplement": "string", "reason": "string", "timing": "string" }],
  "nutrition_coach_message": "string (max 30 words${name ? `, address ${name} by name` : ''})`,
  "calorie_breakdown_note": "string"
}`;
};

// ── Parse JSON safely ────────────────────────────────────────────────────────
const parseJSON = (raw) => {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error('Nutrition plan JSON parse failed:', err.message, raw.slice(0, 300));
    throw new Error('AI returned invalid JSON');
  }
};

// ── Enrich plan meals with ymove recipe images ────────────────────────────────
const enrichWithYmove = async (plan) => {
  const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const enriched = { ...plan, week: { ...plan.week } };

  await Promise.allSettled(
    DAYS.map(async (day) => {
      const dayData = plan.week?.[day];
      if (!dayData?.meals?.length) return;
      enriched.week[day] = {
        ...dayData,
        meals: await Promise.all(
          dayData.meals.map(async (meal) => {
            const term = meal.ymove_recipe_search_term;
            if (!term) return meal;
            try {
              const { recipes } = await ymove.getRecipes({ query: term, limit: 1 });
              const r = recipes?.[0];
              if (r) return { ...meal, ymove_image_url: r.imageUrl || r.thumbnailUrl || null, ymove_recipe_id: r.ymoveId || r.id || null };
            } catch(_) {}
            return meal;
          })
        ),
      };
    })
  );

  return enriched;
};

// ── Calculate all values and return with plan ─────────────────────────────────
const calculateNutritionTargets = (user) => {
  const weightKg  = (user.weight || 150) * 0.453592;
  const heightCm  = parseHeightToCm(user.height);
  const bmr       = calcBMR(weightKg, heightCm, user.age, user.gender);
  const tdee      = calcTDEE(bmr, user.daysPerWeek);
  const calorieTarget = calcCalorieTarget(tdee, user.nutritionGoal, user.gender);
  const { proteinG, fatG, carbG } = calcMacros(calorieTarget, weightKg, user.nutritionGoal);
  return { bmr, tdee, calorieTarget, proteinG, fatG, carbG, weightKg: Math.round(weightKg * 10) / 10 };
};

// ── Main export ───────────────────────────────────────────────────────────────
const generateNutritionPlan = async (user) => {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const calcs = calculateNutritionTargets(user);
  logger.info(`Generating nutrition plan for user ${user.id} (goal=${user.nutritionGoal}, ${calcs.calorieTarget} cal/day)`);

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 10000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: buildPrompt(user, calcs) }],
  });

  const raw  = message.content[0]?.text || '';
  const plan = parseJSON(raw);
  logger.info(`Nutrition plan generated for user ${user.id}: "${plan.plan_name}" (${message.usage?.output_tokens || 0} tokens)`);

  const enriched = await enrichWithYmove(plan);
  return { plan: enriched, calcs };
};

module.exports = { generateNutritionPlan, calculateNutritionTargets };
