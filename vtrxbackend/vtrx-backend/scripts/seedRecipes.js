// ─────────────────────────────────────────────────────────────────────────────
// scripts/seedRecipes.js — Seed recipe library into the database
// Run: node scripts/seedRecipes.js
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RECIPES = [
  {
    name: "Grilled Salmon Bowl",
    calories: 435, protein: 38, carbs: 28, fat: 15,
    prepTime: 25, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=600&q=80",
    tags: ["High Protein","Muscle Gain"],
    description: "A nutrient-dense bowl packed with omega-3 rich salmon, fluffy quinoa, and fresh greens. Perfect post-workout fuel.",
    ingredients: ["2 salmon fillets (6 oz each)","1 cup quinoa","2 cups mixed greens","1 avocado, sliced","½ cup cherry tomatoes","2 tbsp olive oil","Juice of 1 lemon","Sea salt & black pepper"],
    instructions: ["Season salmon fillets with lemon juice, olive oil, salt and pepper.","Cook quinoa according to package instructions.","Heat grill or pan over medium-high heat and cook salmon 4 minutes each side.","Divide greens and quinoa between bowls.","Top with salmon, avocado and cherry tomatoes."],
  },
  {
    name: "Chicken Power Bowl",
    calories: 485, protein: 42, carbs: 32, fat: 14,
    prepTime: 20, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=80",
    tags: ["High Protein","Meal Prep"],
    description: "Lean grilled chicken over brown rice and black beans — a complete protein meal that meal-preps perfectly for the week.",
    ingredients: ["200g chicken breast","½ cup brown rice","1 cup baby spinach","½ cup black beans, drained","1 tbsp olive oil","2 garlic cloves, minced","1 tsp paprika","Salt & pepper"],
    instructions: ["Season chicken with garlic, paprika, salt and pepper.","Cook brown rice according to package instructions.","Heat olive oil in a pan and cook chicken 6–7 minutes each side until cooked through.","Slice chicken and assemble bowl with rice, spinach and black beans.","Drizzle with remaining olive oil."],
  },
  {
    name: "Turkey Stir Fry",
    calories: 320, protein: 36, carbs: 14, fat: 12,
    prepTime: 18, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600&q=80",
    tags: ["Low Carb","Weight Loss"],
    description: "Lean turkey mince stir-fried with crisp broccoli and bell peppers in a savory soy-sesame sauce. Low carb and high protein.",
    ingredients: ["200g turkey mince","1 cup broccoli florets","1 red bell pepper, sliced","2 tbsp soy sauce","1 tbsp sesame oil","2 garlic cloves","1 tsp fresh ginger, grated","1 tsp cornstarch"],
    instructions: ["Heat sesame oil in a wok over high heat.","Brown turkey mince, breaking up lumps, about 5 minutes.","Add garlic and ginger, cook 1 minute.","Add broccoli and bell pepper, stir fry 3–4 minutes.","Mix soy sauce and cornstarch, pour over and toss to coat."],
  },
  {
    name: "Greek Yogurt Protein Bowl",
    calories: 320, protein: 28, carbs: 30, fat: 8,
    prepTime: 5, servings: 1,
    imageUrl: "https://images.unsplash.com/photo-1488477181946-6428a0291777?w=600&q=80",
    tags: ["High Protein","Muscle Gain"],
    description: "Thick Greek yogurt loaded with protein powder, fresh blueberries and crunchy granola. A no-cook breakfast done in 5 minutes.",
    ingredients: ["200g full-fat Greek yogurt","1 scoop vanilla protein powder","½ cup fresh blueberries","1 tbsp raw honey","2 tbsp granola","1 tbsp chia seeds"],
    instructions: ["Whisk protein powder into Greek yogurt until smooth.","Transfer to a bowl.","Top with blueberries, granola and chia seeds.","Drizzle honey over the top and serve immediately."],
  },
  {
    name: "Egg White Omelette",
    calories: 280, protein: 32, carbs: 10, fat: 10,
    prepTime: 12, servings: 1,
    imageUrl: "https://images.unsplash.com/photo-1510693206972-df098062cb71?w=600&q=80",
    tags: ["Weight Loss","Low Carb"],
    description: "Fluffy egg white omelette packed with spinach, mushrooms and tomatoes. Light yet filling — ideal for a weight-loss breakfast.",
    ingredients: ["5 egg whites","1 whole egg","½ cup baby spinach","¼ cup mushrooms, sliced","¼ cup cherry tomatoes, halved","1 tsp olive oil","Salt, pepper & herbs"],
    instructions: ["Whisk egg whites and whole egg together with salt and pepper.","Heat olive oil in a non-stick pan over medium heat.","Sauté mushrooms 2 minutes, add spinach and tomatoes.","Pour egg mixture over vegetables.","Cook until edges set, then fold omelette in half and serve."],
  },
  {
    name: "Sweet Potato Black Bean Bowl",
    calories: 420, protein: 14, carbs: 68, fat: 10,
    prepTime: 30, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=600&q=80",
    tags: ["Vegan","Vegetarian"],
    description: "Roasted sweet potato wedges over seasoned black beans and fresh corn, finished with lime and coriander. Naturally vegan and satisfying.",
    ingredients: ["2 medium sweet potatoes, cubed","1 can black beans, drained","½ cup corn kernels","1 avocado","1 lime","1 tsp cumin","1 tsp smoked paprika","Fresh coriander"],
    instructions: ["Preheat oven to 200°C (400°F).","Toss sweet potato with oil, cumin, paprika, salt. Roast 25 minutes.","Warm black beans in a pan with remaining spices.","Assemble bowl: sweet potato, beans, corn, avocado.","Squeeze lime over everything and top with fresh coriander."],
  },
  {
    name: "Tuna Chickpea Salad",
    calories: 310, protein: 34, carbs: 20, fat: 9,
    prepTime: 5, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=80",
    tags: ["High Protein","Meal Prep"],
    description: "A no-cook, meal-prep friendly salad with canned tuna, chickpeas and crisp vegetables. Lasts 3 days in the fridge.",
    ingredients: ["1 can tuna in spring water, drained","1 can chickpeas, drained","½ cucumber, diced","1 cup cherry tomatoes, halved","¼ red onion, finely sliced","2 tbsp olive oil","Juice of 1 lemon","Salt & pepper"],
    instructions: ["Drain and rinse tuna and chickpeas.","Chop all vegetables and combine in a large bowl.","Add tuna and chickpeas.","Whisk olive oil and lemon juice, season with salt and pepper.","Pour dressing over salad and toss to combine."],
  },
  {
    name: "Overnight Oats",
    calories: 380, protein: 20, carbs: 52, fat: 10,
    prepTime: 5, servings: 1,
    imageUrl: "https://images.unsplash.com/photo-1495214783159-3503fd1b572d?w=600&q=80",
    tags: ["Meal Prep","Muscle Gain"],
    description: "Prep these the night before and wake up to a ready-to-eat, protein-rich breakfast. Customize toppings daily to keep it interesting.",
    ingredients: ["½ cup rolled oats","1 cup unsweetened almond milk","1 scoop protein powder","1 ripe banana, sliced","1 tbsp natural peanut butter","1 tbsp chia seeds","Pinch of cinnamon"],
    instructions: ["Combine oats, almond milk, protein powder and chia seeds in a jar.","Stir well and seal.","Refrigerate overnight (minimum 6 hours).","In the morning, stir and top with banana slices and peanut butter."],
  },
  {
    name: "Avocado Toast & Eggs",
    calories: 350, protein: 18, carbs: 28, fat: 20,
    prepTime: 8, servings: 1,
    imageUrl: "https://images.unsplash.com/photo-1541519227354-08fa5d50c820?w=600&q=80",
    tags: ["Vegetarian","Weight Loss"],
    description: "Creamy mashed avocado on whole grain toast topped with perfectly poached eggs. A balanced meal with healthy fats and protein.",
    ingredients: ["2 slices whole grain bread","1 ripe avocado","2 large eggs","Juice of half a lemon","Chilli flakes","Salt & freshly ground black pepper"],
    instructions: ["Toast bread slices until golden and crisp.","Halve avocado, remove stone and scoop flesh into a bowl.","Mash avocado with lemon juice, salt and pepper.","Bring a pan of water to a gentle simmer and poach eggs 3–4 minutes.","Spread avocado on toast and top with poached eggs and chilli flakes."],
  },
  {
    name: "Beef & Broccoli",
    calories: 450, protein: 38, carbs: 26, fat: 18,
    prepTime: 20, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1603360946369-dc9bb6258143?w=600&q=80",
    tags: ["High Protein","Muscle Gain"],
    description: "Tender lean beef strips and crisp broccoli in a rich soy-oyster sauce. A classic muscle-building meal served over brown rice.",
    ingredients: ["300g lean beef sirloin, thinly sliced","2 cups broccoli florets","3 tbsp soy sauce","1 tbsp oyster sauce","1 tsp sesame oil","2 garlic cloves","1 tsp fresh ginger","1 tsp cornstarch","Brown rice to serve"],
    instructions: ["Marinate beef in soy sauce, oyster sauce and cornstarch for 10 minutes.","Steam broccoli 3 minutes until bright green and tender-crisp.","Heat sesame oil in a wok over high heat.","Stir-fry beef 2–3 minutes until browned.","Add garlic, ginger and broccoli, toss with any remaining marinade. Serve over rice."],
  },
  {
    name: "Protein Smoothie Bowl",
    calories: 340, protein: 30, carbs: 38, fat: 8,
    prepTime: 5, servings: 1,
    imageUrl: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=600&q=80",
    tags: ["Muscle Gain","High Protein"],
    description: "A thick, spoonable smoothie bowl packed with frozen fruit and protein powder, topped with crunchy granola and fresh berries.",
    ingredients: ["1 scoop vanilla protein powder","1 frozen banana","½ cup frozen mixed berries","¼ cup unsweetened almond milk","Granola, fresh fruit and hemp seeds to top"],
    instructions: ["Blend protein powder, frozen banana, berries and almond milk until very thick.","Pour into a bowl — it should be thick enough to hold toppings.","Arrange granola, fresh fruit and hemp seeds on top.","Serve immediately."],
  },
  {
    name: "Lentil Veggie Soup",
    calories: 290, protein: 16, carbs: 42, fat: 6,
    prepTime: 35, servings: 4,
    imageUrl: "https://images.unsplash.com/photo-1547592166-23ac45744acd?w=600&q=80",
    tags: ["Vegan","Vegetarian","Meal Prep"],
    description: "A hearty, warming soup loaded with red lentils and vegetables. Batch-cook on Sunday and eat all week.",
    ingredients: ["1 cup red lentils, rinsed","2 carrots, diced","2 celery stalks, sliced","1 large onion, diced","3 garlic cloves","1 can diced tomatoes","4 cups vegetable broth","1 tsp cumin","1 tsp turmeric","Salt & pepper"],
    instructions: ["Sauté onion, garlic, carrots and celery in olive oil for 5 minutes.","Add cumin and turmeric, cook 1 minute.","Add lentils, diced tomatoes and vegetable broth.","Bring to a boil, then simmer 25 minutes until lentils are soft.","Season with salt and pepper. Blend partially for a creamier texture if desired."],
  },
  {
    name: "Baked Lemon Herb Chicken",
    calories: 310, protein: 44, carbs: 4, fat: 12,
    prepTime: 30, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?w=600&q=80",
    tags: ["High Protein","Low Carb","Weight Loss"],
    description: "Juicy baked chicken breasts marinated in lemon, garlic and herbs. One of the leanest high-protein meals you can make.",
    ingredients: ["2 large chicken breasts","2 tbsp olive oil","Juice of 1 lemon","3 garlic cloves, minced","1 tsp dried oregano","1 tsp dried thyme","Salt & black pepper"],
    instructions: ["Preheat oven to 200°C (400°F).","Whisk olive oil, lemon juice, garlic and herbs.","Coat chicken in marinade and leave 10 minutes.","Bake 22–25 minutes until internal temp reaches 75°C.","Rest 5 minutes before slicing and serving."],
  },
  {
    name: "Quinoa Black Bean Salad",
    calories: 380, protein: 18, carbs: 55, fat: 10,
    prepTime: 20, servings: 3,
    imageUrl: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=80",
    tags: ["Vegan","Vegetarian","Meal Prep"],
    description: "A colourful, protein-rich vegan salad that doubles as a side or main. Keeps well in the fridge for 4 days.",
    ingredients: ["1 cup quinoa","1 can black beans, drained","1 cup corn kernels","1 red bell pepper, diced","½ red onion, diced","Juice of 2 limes","3 tbsp olive oil","Fresh coriander","1 tsp cumin"],
    instructions: ["Cook quinoa per package instructions, fluff and let cool.","Combine quinoa with black beans, corn, bell pepper and onion.","Whisk lime juice, olive oil and cumin for dressing.","Pour dressing over salad and toss well.","Fold in fresh coriander before serving."],
  },
  {
    name: "Shrimp & Cauliflower Rice",
    calories: 265, protein: 30, carbs: 14, fat: 10,
    prepTime: 15, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600&q=80",
    tags: ["Low Carb","Weight Loss","High Protein"],
    description: "Garlic butter shrimp over cauliflower rice — all the satisfaction with a fraction of the carbs.",
    ingredients: ["300g large shrimp, peeled","1 head cauliflower, riced","3 garlic cloves, minced","2 tbsp butter","1 tbsp olive oil","Juice of half a lemon","Fresh parsley","Chilli flakes","Salt & pepper"],
    instructions: ["Rice cauliflower by pulsing florets in a food processor.","Cook cauliflower rice in a dry pan 4–5 minutes.","In another pan, heat butter and olive oil.","Cook shrimp with garlic and chilli 2–3 minutes each side.","Plate cauliflower rice, top with shrimp and squeeze lemon over. Garnish with parsley."],
  },
  {
    name: "Protein Pancakes",
    calories: 390, protein: 35, carbs: 38, fat: 10,
    prepTime: 15, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&q=80",
    tags: ["Muscle Gain","High Protein"],
    description: "Fluffy protein-packed pancakes made with oats and banana. Top with berries and a drizzle of honey for a pre-workout breakfast.",
    ingredients: ["2 scoops vanilla protein powder","1 cup rolled oats","2 ripe bananas","2 large eggs","½ cup almond milk","1 tsp baking powder","Pinch of cinnamon","Berries and honey to serve"],
    instructions: ["Blend oats into a flour using a blender or food processor.","Blend in protein powder, bananas, eggs, almond milk, baking powder and cinnamon until smooth.","Heat a non-stick pan over medium heat, lightly oiled.","Pour ¼ cup batter per pancake and cook 2–3 minutes each side.","Serve stacked with berries and a drizzle of honey."],
  },
  {
    name: "Tofu Veggie Stir Fry",
    calories: 310, protein: 20, carbs: 28, fat: 14,
    prepTime: 20, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1512058564366-18510be2db19?w=600&q=80",
    tags: ["Vegan","Vegetarian","Low Carb"],
    description: "Crispy tofu stir-fried with colourful vegetables in a savoury ginger-soy sauce. Ready in 20 minutes.",
    ingredients: ["400g firm tofu, pressed and cubed","1 cup broccoli florets","1 carrot, julienned","1 red bell pepper","3 tbsp soy sauce","1 tbsp sesame oil","1 tbsp rice vinegar","2 garlic cloves","1 tbsp fresh ginger"],
    instructions: ["Press tofu dry with paper towels, cube and pan-fry in oil until golden on all sides.","Set aside tofu.","Stir-fry garlic and ginger 30 seconds.","Add vegetables and cook 4–5 minutes.","Return tofu, add soy sauce, sesame oil and rice vinegar. Toss and serve."],
  },
  {
    name: "Stuffed Bell Peppers",
    calories: 420, protein: 32, carbs: 36, fat: 14,
    prepTime: 40, servings: 4,
    imageUrl: "https://images.unsplash.com/photo-1563805042-7684c019e1cb?w=600&q=80",
    tags: ["High Protein","Meal Prep"],
    description: "Bell peppers stuffed with lean ground beef, rice and tomato sauce then baked until tender. Perfect meal prep — freezes well.",
    ingredients: ["4 large bell peppers, tops cut off","300g lean ground beef","1 cup cooked brown rice","1 can diced tomatoes","1 onion, diced","2 garlic cloves","1 tsp Italian seasoning","Salt & pepper"],
    instructions: ["Preheat oven to 190°C (375°F).","Sauté onion and garlic 3 minutes. Add beef and cook until browned.","Stir in diced tomatoes, cooked rice and seasoning.","Fill peppers with beef mixture and place in a baking dish.","Bake 30 minutes until peppers are tender."],
  },
  {
    name: "Chia Seed Pudding",
    calories: 280, protein: 10, carbs: 28, fat: 14,
    prepTime: 5, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1614777986387-015c2a89b852?w=600&q=80",
    tags: ["Vegan","Vegetarian","Meal Prep"],
    description: "Creamy coconut chia pudding loaded with omega-3s and topped with mango and berries. Set it overnight, eat it all week.",
    ingredients: ["¼ cup chia seeds","1 cup coconut milk","1 tbsp maple syrup","½ tsp vanilla extract","½ cup mango, diced","Fresh berries to top"],
    instructions: ["Whisk chia seeds, coconut milk, maple syrup and vanilla together.","Let sit 5 minutes then whisk again to prevent clumping.","Refrigerate for at least 4 hours or overnight.","Stir before serving and top with mango and fresh berries."],
  },
  {
    name: "Black Bean Tacos",
    calories: 360, protein: 14, carbs: 48, fat: 12,
    prepTime: 15, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1565299585323-38d6b0865b47?w=600&q=80",
    tags: ["Vegan","Vegetarian"],
    description: "Quick spiced black bean tacos with fresh salsa, avocado and crunchy slaw. A crowd-pleasing plant-based dinner in under 15 minutes.",
    ingredients: ["1 can black beans, drained","8 corn tortillas","1 avocado, sliced","1 cup red cabbage, shredded","1 lime","1 tsp cumin","1 tsp smoked paprika","Fresh salsa","Coriander"],
    instructions: ["Warm black beans with cumin, paprika, salt and a splash of water until heated through.","Warm tortillas in a dry pan 30 seconds each side.","Toss cabbage with lime juice and salt.","Assemble tacos: beans, cabbage, avocado and salsa.","Finish with coriander and an extra squeeze of lime."],
  },
  {
    name: "Salmon & Asparagus Sheet Pan",
    calories: 390, protein: 40, carbs: 12, fat: 20,
    prepTime: 22, servings: 2,
    imageUrl: "https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=600&q=80",
    tags: ["High Protein","Low Carb","Weight Loss"],
    description: "Everything cooks on one pan. Omega-3 rich salmon and crisp asparagus roasted with lemon and garlic. Minimal cleanup.",
    ingredients: ["2 salmon fillets","1 bunch asparagus, trimmed","2 tbsp olive oil","3 garlic cloves, minced","Juice of 1 lemon","1 tsp dried dill","Salt & black pepper","Lemon slices to serve"],
    instructions: ["Preheat oven to 210°C (425°F). Line a baking sheet.","Toss asparagus with half the olive oil, garlic, salt and pepper.","Place salmon on the pan. Rub with remaining olive oil, dill and lemon juice.","Arrange asparagus around salmon.","Roast 12–15 minutes until salmon flakes easily. Serve with lemon slices."],
  },
  {
    name: "Turkey & Rice Meal Prep Bowl",
    calories: 440, protein: 38, carbs: 40, fat: 12,
    prepTime: 25, servings: 4,
    imageUrl: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=80",
    tags: ["High Protein","Meal Prep","Weight Loss"],
    description: "A lean bulk staple. Ground turkey, brown rice and roasted broccoli — prep four portions at once for the week.",
    ingredients: ["400g lean ground turkey","2 cups brown rice","2 cups broccoli florets","1 tbsp olive oil","3 garlic cloves","1 tbsp soy sauce","1 tsp garlic powder","Salt & pepper"],
    instructions: ["Cook brown rice per package instructions.","Brown ground turkey with garlic and garlic powder in olive oil.","Add soy sauce and cook 1 more minute.","Roast broccoli at 200°C for 15 minutes.","Divide rice, turkey and broccoli into four meal prep containers."],
  },
  {
    name: "Cottage Cheese & Fruit Bowl",
    calories: 250, protein: 24, carbs: 26, fat: 5,
    prepTime: 5, servings: 1,
    imageUrl: "https://images.unsplash.com/photo-1488477181946-6428a0291777?w=600&q=80",
    tags: ["High Protein","Weight Loss"],
    description: "High-protein cottage cheese topped with seasonal fruit, a drizzle of honey and crunchy walnuts. A simple, no-cook breakfast under 250 calories.",
    ingredients: ["200g low-fat cottage cheese","½ cup mixed berries","½ peach or pear, sliced","1 tbsp honey","2 tbsp walnuts, roughly chopped","Pinch of cinnamon"],
    instructions: ["Spoon cottage cheese into a bowl.","Arrange berries and sliced peach on top.","Scatter walnuts and drizzle with honey.","Finish with a pinch of cinnamon and serve immediately."],
  },
  {
    name: "Post-Workout Protein Shake",
    calories: 310, protein: 40, carbs: 30, fat: 5,
    prepTime: 3, servings: 1,
    imageUrl: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=600&q=80",
    tags: ["Muscle Gain","High Protein"],
    description: "The perfect recovery shake — fast-digesting protein and carbs to kickstart muscle repair within 30 minutes of training.",
    ingredients: ["2 scoops chocolate whey protein","1 banana","1 cup low-fat milk","1 tbsp peanut butter","4–5 ice cubes"],
    instructions: ["Add all ingredients to a blender.","Blend on high until completely smooth.","Pour into a glass and drink within 30 minutes of finishing your workout."],
  },
  {
    name: "Egg & Veggie Muffins",
    calories: 180, protein: 16, carbs: 6, fat: 10,
    prepTime: 25, servings: 6,
    imageUrl: "https://images.unsplash.com/photo-1510693206972-df098062cb71?w=600&q=80",
    tags: ["Meal Prep","Low Carb","Weight Loss"],
    description: "Mini egg muffins packed with vegetables and feta — meal prep 12 at once and grab two for a protein-packed breakfast all week.",
    ingredients: ["6 large eggs","¼ cup milk","½ cup spinach, chopped","¼ cup red bell pepper, diced","¼ cup cherry tomatoes, halved","¼ cup feta cheese, crumbled","Salt, pepper & dried oregano"],
    instructions: ["Preheat oven to 180°C (350°F). Grease a muffin tin.","Whisk eggs and milk with salt, pepper and oregano.","Divide vegetables evenly between muffin cups.","Pour egg mixture over vegetables.","Sprinkle feta on top and bake 18–20 minutes until set."],
  },
];

async function main() {
  console.log(`Seeding ${RECIPES.length} recipes...`);
  let created = 0;
  let skipped = 0;

  for (const recipe of RECIPES) {
    const existing = await prisma.recipe.findFirst({ where: { name: recipe.name } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.recipe.create({ data: { ...recipe, isPublic: true } });
    created++;
    console.log(`  ✓ ${recipe.name}`);
  }

  console.log(`\nDone — ${created} created, ${skipped} already existed.`);
}

// Export for use by server.js on startup
const run = () => main().finally(() => prisma.$disconnect());
module.exports = { run };

// Allow direct invocation: node scripts/seedRecipes.js
if (require.main === module) {
  run().catch(e => { console.error(e); process.exit(1); });
}
