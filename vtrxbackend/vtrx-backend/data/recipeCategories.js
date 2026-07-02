// ─────────────────────────────────────────────────────────────────────────────
// data/recipeCategories.js — Recipe category taxonomy (single source of truth)
//
// 11 categories: 8 driven by Recipe.tags (multi-select), 3 by Recipe.mealType
// (single-select). seedRecipes.js and nutritionController.js both import this
// so category strings can never drift out of sync between seeding and querying.
// ─────────────────────────────────────────────────────────────────────────────

const TAGS = {
  HIGH_PROTEIN:  'High Protein',
  WEIGHT_LOSS:   'Weight Loss',
  MUSCLE_GAIN:   'Muscle Gain',
  LOW_CALORIE:   'Low Calorie',
  VEGETARIAN:    'Vegetarian',
  VEGAN:         'Vegan',
  QUICK_MEAL:    'Quick Meal',
  HEALTHY_SNACK: 'Healthy Snack',
};

const MEAL_TYPES = {
  BREAKFAST: 'Breakfast',
  LUNCH:     'Lunch',
  DINNER:    'Dinner',
};

const CATEGORY_LIMIT = 10;

const RECIPE_CATEGORIES = [
  { key: 'high_protein',   label: 'High Protein',   type: 'tag',      value: TAGS.HIGH_PROTEIN },
  { key: 'weight_loss',    label: 'Weight Loss',    type: 'tag',      value: TAGS.WEIGHT_LOSS },
  { key: 'muscle_gain',    label: 'Muscle Gain',    type: 'tag',      value: TAGS.MUSCLE_GAIN },
  { key: 'low_calorie',    label: 'Low Calorie',    type: 'tag',      value: TAGS.LOW_CALORIE },
  { key: 'vegetarian',     label: 'Vegetarian',     type: 'tag',      value: TAGS.VEGETARIAN },
  { key: 'vegan',          label: 'Vegan',          type: 'tag',      value: TAGS.VEGAN },
  { key: 'quick_meals',    label: 'Quick Meals',    type: 'tag',      value: TAGS.QUICK_MEAL },
  { key: 'healthy_snacks', label: 'Healthy Snacks', type: 'tag',      value: TAGS.HEALTHY_SNACK },
  { key: 'breakfast',      label: 'Breakfast',      type: 'mealType', value: MEAL_TYPES.BREAKFAST },
  { key: 'lunch',          label: 'Lunch',          type: 'mealType', value: MEAL_TYPES.LUNCH },
  { key: 'dinner',         label: 'Dinner',         type: 'mealType', value: MEAL_TYPES.DINNER },
];

module.exports = { TAGS, MEAL_TYPES, CATEGORY_LIMIT, RECIPE_CATEGORIES };
