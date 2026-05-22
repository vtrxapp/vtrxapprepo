import React, { useState, useEffect, useRef, createContext, useContext } from "react";
import ReactDOM from "react-dom/client";



// ── API Configuration ─────────────────────────────────────────────────────────
const API_URL = typeof import_meta_env !== "undefined"
  ? (import_meta_env.VITE_API_URL || "")
  : "";

// When no real backend URL is set, all API calls silently succeed (demo/preview mode)
const DEMO_MODE = !API_URL;

// ── API Helper ────────────────────────────────────────────────────────────────
const apiCall = async (endpoint, options = {}) => {
  // Demo/preview mode — no backend configured, return mock success
  if (DEMO_MODE) {
    // Simulate a brief network delay
    await new Promise(r => setTimeout(r, 400));
    // Return plausible mock responses per endpoint
    if (endpoint === "/auth/signup")         return { success:true, data:{ message:"Account created" } };
    if (endpoint === "/auth/confirm-email")  return { success:true, data:{ message:"Verified" } };
    if (endpoint === "/auth/login")          return { success:true, data:{ token:"demo_token", user:{ id:"demo", name:"Demo User", email:"demo@vtrx.app" }, cognitoTokens:{} } };
    if (endpoint === "/auth/me")             return { success:true, data:{ id:"demo", name:"Demo User", email:"demo@vtrx.app", isPremium:false } };
    if (endpoint === "/auth/logout")         return { success:true };
    if (endpoint === "/auth/forgot-password")return { success:true };
    if (endpoint === "/auth/reset-password") return { success:true };
    if (endpoint === "/payments/create-checkout") return { success:true, data:{ url:"#" } };
    if (endpoint === "/notifications")       return { success:true, data:[] };
    if (endpoint === "/users/mood")          return { success:true };
    if (endpoint === "/workouts/log")        return { success:true };
    return { success:true, data:{} };
  }
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("vtrx_token") : null;
  const res   = await fetch(`${API_URL}${endpoint}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    ...options,
  });
  const data = await res.json();
  if (!data.success && res.status >= 400) throw Object.assign(new Error(data.message || "Request failed"), { status: res.status, code: data.code });
  return data;
};

// ── Auth Storage Helpers ──────────────────────────────────────────────────────
const storeAuth = (token, user) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem("vtrx_token", token);
  localStorage.setItem("vtrx_user",  JSON.stringify(user));
};
const clearAuth = () => {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem("vtrx_token");
  localStorage.removeItem("vtrx_user");
  localStorage.removeItem("vtrx_cognito_token");
};
const getStoredUser = () => {
  try {
    if (typeof localStorage === "undefined") return null;
    const u = localStorage.getItem("vtrx_user");
    return u ? JSON.parse(u) : null;
  } catch { return null; }
};

const UserCtx = createContext(null);
const useUser = () => useContext(UserCtx);

// ── Premium gate component ────────────────────────────────────────────────────
function PremiumGate({ feature, children, mini=false }) {
  const { isPremium, setIsPremium } = useUser();
  if (isPremium) return children;
  if (mini) return (
    <div ref={histScrollRef} style={{position:"relative",overflow:"hidden",borderRadius:16 }}>
      <div style={{ filter:"blur(4px)",pointerEvents:"none",userSelect:"none" }}>{children}</div>
      <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(10,10,10,0.75)",backdropFilter:"blur(2px)",borderRadius:16,padding:16 }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="2" style={{marginBottom:8}}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <div style={{ fontFamily:"'Montserrat',sans-serif",fontWeight:800,fontSize:12,color:"#fff",marginBottom:4,textAlign:"center" }}>Premium Feature</div>
        <button onClick={()=>setIsPremium(true)} style={{ padding:"6px 16px",borderRadius:50,background:"#00A3FF",border:"none",fontFamily:"'Montserrat',sans-serif",fontWeight:700,fontSize:11,color:"#fff",cursor:"pointer" }}>Unlock</button>
      </div>
    </div>
  );
  return (
    <div style={{ position:"absolute",inset:0,background:"#0a0a0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,zIndex:100 }}>
      <div style={{ width:72,height:72,borderRadius:"50%",background:"rgba(0,163,255,0.12)",border:"2px solid rgba(0,163,255,0.4)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:20 }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      </div>
      <div style={{ fontFamily:"'Montserrat',sans-serif",fontWeight:900,fontSize:22,color:"#fff",marginBottom:8,textAlign:"center" }}>Premium Feature</div>
      <div style={{ fontFamily:"'Montserrat',sans-serif",fontSize:13,color:"#888",marginBottom:6,textAlign:"center",lineHeight:1.6 }}>{feature}</div>
      <div style={{ fontFamily:"'Montserrat',sans-serif",fontSize:12,color:"#555",marginBottom:28,textAlign:"center" }}>Unlock with VTRX Premium</div>
      <button onClick={()=>setIsPremium(true)}
        style={{ width:"100%",maxWidth:280,padding:"15px 0",borderRadius:50,background:"#00A3FF",border:"none",fontFamily:"'Montserrat',sans-serif",fontWeight:800,fontSize:15,color:"#fff",cursor:"pointer",marginBottom:14,boxShadow:"0 4px 24px rgba(0,163,255,0.4)" }}>
        Upgrade to Premium
      </button>
      <div style={{ fontFamily:"'Montserrat',sans-serif",fontSize:11,color:"#444" }}>$5.83/month · Cancel anytime</div>
    </div>
  );
}
const useTheme = () => ({ dark: true });

// ── useScrollRestore: saves & restores scroll position per page key ───────────

// Global scroll position store (persists across mounts within session)
const _scrollStore = {};
function useScrollPos(key) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Restore
    if (_scrollStore[key]) el.scrollTop = _scrollStore[key];
    const save = () => { _scrollStore[key] = el.scrollTop; };
    el.addEventListener('scroll', save, { passive: true });
    return () => el.removeEventListener('scroll', save);
  }, [key]);
  return ref;
}



// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & DATA
// ─────────────────────────────────────────────────────────────────────────────
const PRIMARY = "#00A3FF"; const FONT = "'Montserrat', sans-serif";
// Theme-aware: components call useTheme() for BG/CARD/TEXT/BORDER
const BG = "#0a0a0a"; const CARD = "#141414"; const CARD2 = "#1a1a1a"; const BORDER = "#242424";
const DARK  = { bg:BG, card:CARD, card2:CARD2, border:BORDER, text:"#ffffff", sub:"#888888", invert:"#111111" };
const LIGHT = DARK; // Dark-only MVP

const QUOTES = [
  { text: "The pain you feel today will be the strength you feel tomorrow. Push through your limits!", author: "Arnold Schwarzenegger" },
  { text: "Success usually comes to those who are too busy to be looking for it.", author: "Henry David Thoreau" },
  { text: "The only bad workout is the one that didn't happen.", author: "Unknown" },
  { text: "Don't stop when you're tired. Stop when you're done.", author: "David Goggins" },
  { text: "Take care of your body. It's the only place you have to live.", author: "Jim Rohn" },
];

const MEALS = [
  { name:"Grilled Salmon Power Bowl", desc:"Omega-3 rich with quinoa and greens. Perfect for muscle recovery.", cal:435, protein:38, carbs:20, fats:15, mins:25, servings:3, img:"https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=600&q=80", ingredients:["2 salmon fillets (6 oz each)","1 cup quinoa","2 cups mixed greens","1 avocado, sliced","½ cup cherry tomatoes","2 tbsp olive oil","Lemon juice & sea salt"], steps:[{title:"Step 1",body:"Season salmon with lemon, olive oil, salt and pepper."},{title:"Step 2",body:"Cook quinoa according to package instructions."},{title:"Step 3",body:"Grill salmon 4 min each side."},{title:"Step 4",body:"Assemble bowl with quinoa, greens and avocado."},{title:"Step 5",body:"Top with salmon and serve."}] },
  { name:"Grilled Chicken Power Bowl", desc:"High protein, low carb. Perfect for muscle recovery and fat burning.", cal:485, protein:42, carbs:15, fats:15, mins:20, servings:2, img:"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&q=80", ingredients:["200g chicken breast","½ cup brown rice","1 cup spinach","½ cup black beans","1 tbsp olive oil","Garlic & herbs"], steps:[{title:"Step 1",body:"Season chicken with garlic, herbs, salt and pepper."},{title:"Step 2",body:"Cook brown rice per package instructions."},{title:"Step 3",body:"Grill chicken 6–7 min each side."},{title:"Step 4",body:"Assemble bowl with rice, spinach, beans and chicken."},{title:"Step 5",body:"Drizzle with olive oil and serve."}] },
  { name:"Turkey & Veggie Stir Fry", desc:"Lean protein with colourful vegetables. Quick, filling and macro-friendly.", cal:390, protein:36, carbs:22, fats:12, mins:18, servings:2, img:"https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600&q=80", ingredients:["200g turkey mince","1 cup broccoli","1 bell pepper","2 tbsp soy sauce","1 tbsp sesame oil","1 tsp ginger","2 garlic cloves"], steps:[{title:"Step 1",body:"Heat sesame oil in a wok over high heat."},{title:"Step 2",body:"Brown turkey mince, breaking apart as it cooks."},{title:"Step 3",body:"Add garlic and ginger, cook 1 min."},{title:"Step 4",body:"Add vegetables and stir fry 3–4 min."},{title:"Step 5",body:"Add soy sauce, toss and serve."}] },
  { name:"Greek Yogurt Protein Bowl", desc:"High protein breakfast or snack. Supports muscle gain and sustained energy.", cal:320, protein:28, carbs:30, fats:8, mins:5, servings:1, img:"https://images.unsplash.com/photo-1488477181946-6428a0291777?w=600&q=80", ingredients:["200g Greek yogurt","1 scoop protein powder","½ cup blueberries","1 tbsp honey","2 tbsp granola","1 tbsp chia seeds"], steps:[{title:"Step 1",body:"Mix protein powder into Greek yogurt until smooth."},{title:"Step 2",body:"Transfer to a bowl."},{title:"Step 3",body:"Top with blueberries, granola and chia seeds."},{title:"Step 4",body:"Drizzle honey over top."},{title:"Step 5",body:"Serve immediately or refrigerate up to 4 hours."}] },
  { name:"Egg White Veggie Omelette", desc:"Low calorie, high protein breakfast. Great for weight loss days.", cal:280, protein:32, carbs:10, fats:10, mins:12, servings:1, img:"https://images.unsplash.com/photo-1510693206972-df098062cb71?w=600&q=80", ingredients:["5 egg whites","1 whole egg","½ cup spinach","¼ cup mushrooms","¼ cup cherry tomatoes","1 tsp olive oil","Salt and pepper"], steps:[{title:"Step 1",body:"Whisk egg whites and whole egg together."},{title:"Step 2",body:"Heat olive oil in a non-stick pan."},{title:"Step 3",body:"Sauté vegetables 2 minutes."},{title:"Step 4",body:"Pour egg mixture over vegetables."},{title:"Step 5",body:"Fold omelette, cook until set and serve."}] },
];


// ─────────────────────────────────────────────────────────────────────────────
// ── NUTRITION DATA ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
const RECIPES = [
  { id:1,  name:"Grilled Salmon Bowl",        cat:["High Protein","Muscle Gain"],  tag:"Lunch",     cal:435, protein:38, carbs:28, fats:15, mins:25, saved:false, img:"https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=400&q=80", ingredients:["2 salmon fillets (6oz)","1 cup quinoa","2 cups mixed greens","1 avocado, sliced","½ cup cherry tomatoes","2 tbsp olive oil","Lemon juice & sea salt"], steps:["Season salmon with lemon, oil, salt & pepper.","Cook quinoa per package.","Grill salmon 4 min each side.","Assemble bowl and top with salmon."] },
  { id:2,  name:"Chicken Power Bowl",         cat:["High Protein","Meal Prep"],    tag:"Lunch",     cal:485, protein:42, carbs:32, fats:14, mins:20, saved:false, img:"https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80", ingredients:["200g chicken breast","½ cup brown rice","1 cup spinach","½ cup black beans","1 tbsp olive oil","Garlic & herbs"], steps:["Season chicken with garlic and herbs.","Cook rice per package.","Grill chicken 6–7 min each side.","Assemble bowl and drizzle with olive oil."] },
  { id:3,  name:"Turkey Stir Fry",            cat:["Low Carb","Weight Loss"],      tag:"Dinner",    cal:320, protein:36, carbs:14, fats:12, mins:18, saved:false, img:"https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=80", ingredients:["200g turkey mince","1 cup broccoli","1 bell pepper","2 tbsp soy sauce","1 tbsp sesame oil","2 garlic cloves"], steps:["Heat sesame oil in wok.","Brown turkey mince.","Add garlic and vegetables.","Stir fry 3–4 min, add soy sauce."] },
  { id:4,  name:"Greek Yogurt Protein Bowl",  cat:["High Protein","Muscle Gain"],  tag:"Breakfast", cal:320, protein:28, carbs:30, fats:8,  mins:5,  saved:false, img:"https://images.unsplash.com/photo-1488477181946-6428a0291777?w=400&q=80", ingredients:["200g Greek yogurt","1 scoop protein powder","½ cup blueberries","1 tbsp honey","2 tbsp granola","1 tbsp chia seeds"], steps:["Mix protein powder into yogurt.","Transfer to bowl.","Top with fruit, granola and chia.","Drizzle honey and serve."] },
  { id:5,  name:"Egg White Omelette",         cat:["Weight Loss","Low Carb"],      tag:"Breakfast", cal:280, protein:32, carbs:10, fats:10, mins:12, saved:false, img:"https://images.unsplash.com/photo-1510693206972-df098062cb71?w=400&q=80", ingredients:["5 egg whites","1 whole egg","½ cup spinach","¼ cup mushrooms","¼ cup cherry tomatoes","1 tsp olive oil"], steps:["Whisk eggs together.","Heat oil and sauté veg 2 min.","Pour eggs over vegetables.","Fold and cook until set."] },
  { id:6,  name:"Sweet Potato Black Bean",    cat:["Vegan","Vegetarian"],          tag:"Dinner",    cal:420, protein:14, carbs:68, fats:10, mins:30, saved:false, img:"https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=400&q=80", ingredients:["2 sweet potatoes","1 can black beans","1 avocado","½ cup corn","1 lime","1 tsp cumin","Fresh coriander"], steps:["Roast sweet potato at 200°C 25 min.","Season black beans with cumin.","Assemble bowl with all ingredients.","Squeeze lime and top with coriander."] },
  { id:7,  name:"Tuna Chickpea Salad",        cat:["High Protein","Meal Prep"],    tag:"Lunch",     cal:310, protein:34, carbs:20, fats:9,  mins:5,  saved:false, img:"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&q=80", ingredients:["1 can tuna in water","1 can chickpeas","½ cucumber","Cherry tomatoes","Red onion","2 tbsp olive oil","Lemon juice"], steps:["Drain tuna and chickpeas.","Chop vegetables.","Combine all ingredients.","Drizzle with oil and lemon, toss."] },
  { id:8,  name:"Overnight Oats",             cat:["Meal Prep","Muscle Gain"],     tag:"Breakfast", cal:380, protein:20, carbs:52, fats:10, mins:5,  saved:false, img:"https://images.unsplash.com/photo-1495214783159-3503fd1b572d?w=400&q=80", ingredients:["½ cup oats","1 cup almond milk","1 scoop protein powder","1 banana","1 tbsp peanut butter","1 tbsp chia seeds"], steps:["Combine oats, milk and protein powder.","Stir in chia seeds.","Refrigerate overnight.","Top with banana and peanut butter."] },
  { id:9,  name:"Avocado Toast & Eggs",       cat:["Vegetarian","Weight Loss"],    tag:"Breakfast", cal:350, protein:18, carbs:28, fats:20, mins:8,  saved:false, img:"https://images.unsplash.com/photo-1541519227354-08fa5d50c820?w=400&q=80", ingredients:["2 slices whole grain bread","1 ripe avocado","2 poached eggs","Chilli flakes","Lemon juice","Salt & pepper"], steps:["Toast bread until golden.","Mash avocado with lemon and seasoning.","Poach eggs 3–4 min.","Assemble and top with chilli flakes."] },
  { id:10, name:"Beef & Broccoli",            cat:["High Protein","Muscle Gain"],  tag:"Dinner",    cal:450, protein:38, carbs:26, fats:18, mins:20, saved:false, img:"https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80", ingredients:["300g lean beef strips","2 cups broccoli","3 tbsp soy sauce","1 tbsp oyster sauce","1 tsp sesame oil","Garlic & ginger","Brown rice to serve"], steps:["Marinate beef in soy and oyster sauce.","Cook rice per package.","Stir fry beef in sesame oil.","Add garlic, ginger and broccoli, toss."] },
  { id:11, name:"Protein Smoothie Bowl",      cat:["Muscle Gain","High Protein"],  tag:"Breakfast", cal:340, protein:30, carbs:38, fats:8,  mins:5,  saved:false, img:"https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=400&q=80", ingredients:["1 scoop protein powder","1 frozen banana","½ cup frozen berries","¼ cup almond milk","Granola, fruit & seeds to top"], steps:["Blend protein, banana, berries and milk until thick.","Pour into bowl.","Top with granola, fresh fruit and seeds."] },
  { id:12, name:"Lentil Veggie Soup",         cat:["Vegan","Vegetarian","Meal Prep"],tag:"Dinner",  cal:290, protein:16, carbs:42, fats:6,  mins:35, saved:false, img:"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&q=80", ingredients:["1 cup red lentils","2 carrots","2 celery stalks","1 onion","2 garlic cloves","1 can diced tomatoes","1 tsp cumin & turmeric"], steps:["Sauté onion, garlic, carrots and celery 5 min.","Add lentils, tomatoes and 4 cups water.","Simmer 25 min until lentils are soft.","Season with cumin and turmeric."] },
];

const NUTRITION_FILTERS = ["All","High Protein","Low Carb","Vegan","Vegetarian","Weight Loss","Muscle Gain","Meal Prep"];

const WEEK_DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

const DEFAULT_MEAL_PLAN = [
  { breakfast:0, lunch:1, dinner:2,  snack:3  },
  { breakfast:7, lunch:6, dinner:9,  snack:3  },
  { breakfast:3, lunch:1, dinner:5,  snack:10 },
  { breakfast:8, lunch:6, dinner:2,  snack:3  },
  { breakfast:10,lunch:1, dinner:11, snack:7  },
  { breakfast:3, lunch:9, dinner:5,  snack:10 },
  { breakfast:7, lunch:6, dinner:2,  snack:3  },
];

const GROCERY_CATEGORIES = {
  "Proteins":    ["Salmon fillets (4x)","Chicken breast (600g)","Turkey mince (400g)","Beef strips (300g)","Eggs (12)","Greek yogurt (600g)","Tuna cans (3x)","Protein powder"],
  "Vegetables":  ["Spinach (200g)","Broccoli (2 heads)","Cherry tomatoes","Bell peppers (3x)","Mushrooms (200g)","Cucumber","Sweet potatoes (4x)","Mixed greens","Carrots (4x)","Celery"],
  "Carbs":       ["Quinoa (500g)","Brown rice (500g)","Oats (500g)","Whole grain bread","Black beans (2 cans)","Chickpeas","Red lentils (500g)","Diced tomatoes (can)"],
  "Fats":        ["Avocados (6x)","Olive oil","Sesame oil","Peanut butter","Chia seeds"],
  "Fruits":      ["Lemons (4x)","Limes (3x)","Blueberries (200g)","Bananas (6x)","Frozen berries (bag)"],
  "Pantry":      ["Soy sauce","Oyster sauce","Honey","Granola","Almond milk (1L)","Garlic","Ginger","Cumin","Turmeric","Chilli flakes","Sea salt & pepper"],
};

const AI_SUGGESTIONS = {
  empty: { title:"Rest Day Nutrition",       tip:"Slight calorie reduction on rest days. Keep protein high to preserve muscle while your body recovers.",              rec:[4,8,6]  },
  low:   { title:"Light Day Fueling",        tip:"Easy movement today — keep meals light but protein-rich. Anti-inflammatory foods like salmon help.",                 rec:[0,6,11] },
  okay:  { title:"Steady Day Nutrition",     tip:"Balanced macros support steady energy. Aim for even distribution across 3–4 meals throughout the day.",              rec:[1,2,3]  },
  good:  { title:"Performance Nutrition",    tip:"You're training hard — fuel accordingly. High protein post-workout and complex carbs to sustain energy.",             rec:[0,1,9]  },
  peak:  { title:"Max Effort Nutrition",     tip:"Carb-loading the night before helps. Post-workout window is critical — eat within 30 min for optimal recovery.",     rec:[0,9,10] },
};

const EXERCISES = [
  { name: "Dumbell Upper Chest", sets: 4, reps: 8, muscles: "Pectorals, Triceps, Front Delts", cal: 50, img: "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=200&q=70" },
  { name: "Lower Chest Fly", sets: 4, reps: 8, muscles: "Pectorals, Triceps, Front Delts", cal: 50, img: "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?w=200&q=70" },
  { name: "Overhead Tricep Extension", sets: 4, reps: 8, muscles: "Pectorals, Triceps, Front Delts", cal: 50, img: "https://images.unsplash.com/photo-1599058945522-28d584b6f0ff?w=200&q=70" },
  { name: "Tricep Pushdown", sets: 4, reps: 8, muscles: "Pectorals, Triceps, Front Delts", cal: 50, img: "https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=200&q=70" },
  { name: "Bench Press", sets: 3, reps: 12, muscles: "Pectorals, Triceps, Front Delts", cal: 60, img: "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=200&q=70" },
  { name: "Dumbbell Rows", sets: 3, reps: 10, muscles: "Back, Biceps, Rear Delts", cal: 55, img: "https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=200&q=70" },
  { name: "Shoulder Press", sets: 3, reps: 10, muscles: "Deltoids, Trapezius, Triceps", cal: 45, img: "https://images.unsplash.com/photo-1574680096145-d05b474e2155?w=200&q=70" },
  { name: "Cable Chest Fly", sets: 3, reps: 12, muscles: "Pectorals, Anterior Deltoids", cal: 40, img: "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?w=200&q=70" },
];

const WEEKLY_DATA = [
  { day: "Mon", cal: 350, type: "strength" },
  { day: "Tue", cal: 0,   type: "rest"     },
  { day: "Wed", cal: 450, type: "hiit"     },
  { day: "Thu", cal: 320, type: "hiit"     },
  { day: "Fri", cal: 400, type: "strength" },
  { day: "Sat", cal: 0,   type: "rest"     },
  { day: "Sun", cal: 450, type: "cardio"   },
];

const TYPE_COLOR = { strength:"#00A3FF", cardio:"#F59E0B", hiit:"#6366F1", rest:"#374151" };

const WORKOUTS = {
  empty: { name: "Recovery Flow",   type: "MOBILITY",  target: "Full Body, Hip Flexors, Hamstrings", mins: 15, cal: 80,  exercises: 5  },
  low:   { name: "Light Cardio",    type: "CARDIO",    target: "Cardiovascular System, Core",         mins: 20, cal: 150, exercises: 5  },
  okay:  { name: "Chest & Triceps", type: "STRENGTH",  target: "Pectorals, Triceps, Anterior Deltoids", mins: 30, cal: 300, exercises: 8  },
  good:  { name: "Full Body Power", type: "STRENGTH",  target: "Full Body, Compound Movements",       mins: 40, cal: 380, exercises: 9  },
  peak:  { name: "Max Effort Day",  type: "STRENGTH",  target: "All Major Muscle Groups",             mins: 55, cal: 480, exercises: 10 },
};

// SVG face icons for energy levels — no emojis
function EnergyFaceIcon({ type, color, size=28 }) {
  const s = { width:size, height:size, viewBox:"0 0 24 24", fill:"none", stroke:color, strokeWidth:"2" };
  if (type==="empty") return <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M8 15s1.5-1 4-1 4 1 4 1"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" strokeLinecap="round"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" strokeLinecap="round"/></svg>;
  if (type==="low")   return <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" strokeLinecap="round"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" strokeLinecap="round"/></svg>;
  if (type==="okay")  return <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M8 14s1 1.5 4 1.5 4-1.5 4-1.5"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" strokeLinecap="round"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" strokeLinecap="round"/></svg>;
  if (type==="good")  return <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M8 13s1 3 4 3 4-3 4-3"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" strokeLinecap="round"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" strokeLinecap="round"/></svg>;
  // peak — flame icon
  return <svg {...s} stroke={color}><path d="M12 2c0 6-6 8-6 14a6 6 0 0012 0c0-6-6-8-6-14z"/><path d="M12 12c0 3-2 4-2 6a2 2 0 004 0c0-2-2-3-2-6z" opacity="0.5"/></svg>;
}

const ENERGY_LEVELS = [
  { key: "empty", faceType: "empty", label: "Running on Empty",   sub: "Rest & recover — gentle session today", color: "#EF4444", bg: "rgba(239,68,68,0.1)"  },
  { key: "low",   faceType: "low",   label: "Getting Through It", sub: "A light push — you can do this",        color: "#F97316", bg: "rgba(249,115,22,0.1)" },
  { key: "okay",  faceType: "okay",  label: "Feeling Okay",       sub: "Standard session ready for you",        color: "#EAB308", bg: "rgba(234,179,8,0.1)"  },
  { key: "good",  faceType: "good",  label: "Feeling Good",       sub: "Let's push a little harder today",      color: "#22C55E", bg: "rgba(34,197,94,0.1)"  },
  { key: "peak",  faceType: "peak",  label: "Let's Go Hard",      sub: "Maximum effort — this is your day",     color: PRIMARY,   bg: "rgba(0,163,255,0.1)"  },
];


// ── Onboarding slide feature icons (SVG, no emojis) ─────────────────────────
function SlideIcon({ type }) {
  const s = { width:18, height:18, viewBox:"0 0 24 24", fill:"none", stroke:"#00A3FF", strokeWidth:"2" };
  // Workouts slide
  if (type==="bolt") return <svg {...s}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
  if (type==="fire") return <svg {...s}><path d="M12 2c0 6-6 8-6 14a6 6 0 0012 0c0-6-6-8-6-14z"/></svg>;
  if (type==="chart") return <svg {...s}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>;
  if (type==="muscle"||type==="muscle") return <svg {...s}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  // Nutrition slide
  if (type==="fork") return <svg {...s}><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>;
  if (type==="bar")  return <svg {...s}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;
  if (type==="drop") return <svg {...s}><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></svg>;
  // Challenge slide
  if (type==="trophy") return <svg {...s}><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2z"/></svg>;
  if (type==="coin")  return <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M12 8v8M9 10h6M9 14h6"/></svg>;
  if (type==="globe") return <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>;
  if (type==="list")  return <svg {...s}><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>;
  // Community slide
  if (type==="users") return <svg {...s}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>;
  if (type==="star")  return <svg {...s}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
  if (type==="medal") return <svg {...s}><circle cx="12" cy="14" r="6"/><path d="M9 2h6l1 7H8l1-7z"/><path d="M9.5 9l-2 5M14.5 9l2 5"/></svg>;
  if (type==="heart") return <svg {...s}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>;
  // Default
  return <svg {...s}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}

const ONBOARDING_SLIDES = [
  {
    id: 0, bg: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800&q=80",
    overlay: "linear-gradient(180deg,rgba(0,0,0,0.3) 0%,rgba(0,0,0,0.5) 45%,rgba(0,0,0,0.88) 100%)",
    tag: "WELCOME TO VTRX",
    headline: ["Transform your body.", "Break past limits.", "Unlock your potential."],
    body: "This isn't just about workouts — it's about redefining what you're capable of. Your goals, your pace, your evolution.",
  },
  {
    id: 1, bg: "https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=800&q=80",
    overlay: "linear-gradient(180deg,rgba(0,0,0,0.25) 0%,rgba(0,0,0,0.5) 40%,rgba(0,0,0,0.88) 100%)",
    tag: "CUSTOM WORKOUTS",
    headline: ["Move with purpose.", "Build strength at your pace.", "Enjoy the journey."],
    features: [{ icon: "bolt",   text: "AI-powered workout plans" },
               { icon: "fire",   text: "High-intensity interval training" },
               { icon: "chart",  text: "Progressive overload tracking" },
               { icon: "muscle", text: "Strength & conditioning" }],
  },
  {
    id: 2, bg: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&q=80",
    overlay: "linear-gradient(180deg,rgba(0,10,20,0.35) 0%,rgba(0,10,20,0.55) 40%,rgba(0,10,20,0.9) 100%)",
    tag: "NUTRITION MASTERY",
    headline: ["Fuel your body with care.", "Make simple, smart choices.", "Feel better inside out."],
    features: [{ icon: "fork",  text: "Macro-based meal planning" },
               { icon: "bar",   text: "Calorie & nutrient tracking" },
               { icon: "fire",  text: "Fat burning meal recipes" },
               { icon: "drop",  text: "Hydration & supplement guides" }],
  },
  {
    id: 3, bg: "https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=800&q=80",
    overlay: "linear-gradient(180deg,rgba(0,0,0,0.4) 0%,rgba(0,0,0,0.5) 40%,rgba(0,0,0,0.9) 100%)",
    tag: "CHALLENGE MODE",
    headline: ["Take on the challenge.", "Grow one day at a time.", "Celebrate every win."],
    features: [{ icon: "coin",   text: "Join with money at stake" },
               { icon: "medal",  text: "Win money and badges" },
               { icon: "fire",   text: "Build habits, not pressure" },
               { icon: "list",   text: "Guided challenge instructions" }],
  },
  {
    id: 4, bg: "https://images.unsplash.com/photo-1550345332-09e3ac987658?w=800&q=80",
    overlay: "linear-gradient(180deg,rgba(0,0,0,0.45) 0%,rgba(0,0,0,0.5) 35%,rgba(0,0,0,0.92) 100%)",
    tag: "START YOUR JOURNEY",
    headline: ["Train together.", "Push each other further.", "Nobody falls behind."],
    cta: true,
  },
];
// ─────────────────────────────────────────────────────────────────────────────
// SHARED MICRO-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function VTRXLogo({ size=20 }) {
  return <svg width={size} height={size*.85} viewBox="0 0 100 85" fill="none"><polygon points="50,28 10,0 0,10 50,48 100,10 90,0" fill={PRIMARY}/><polygon points="50,58 10,30 0,40 50,78 100,40 90,30" fill={PRIMARY} opacity=".7"/></svg>;
}

function BackHeader({ title, right, onBack }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"52px 18px 16px", background:BG, flexShrink:0 }}>
      <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#fff",fontSize:20 }}>‹</button>
      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>{title}</div>
      {right || <div style={{width:36}}/>}
    </div>
  );
}

function CTA({ label, onClick, icon, secondary }) {
  return (
    <button onClick={onClick} style={{
      width:"100%",padding:"16px 0",borderRadius:50,
      border: secondary?"1.5px solid rgba(255,255,255,0.35)":"none",
      background: secondary?"transparent":`linear-gradient(135deg,${PRIMARY},#0068CC)`,
      fontFamily:FONT,fontWeight:800,fontSize:14,
      color: secondary?"rgba(255,255,255,0.85)":"#fff",
      letterSpacing: secondary?0.5:2,cursor:"pointer",
      boxShadow: secondary?"none":`0 4px 28px ${PRIMARY}55`,
      display:"flex",alignItems:"center",justifyContent:"center",gap:8,
    }}>{label}{icon&&<span style={{display:"flex",alignItems:"center",marginLeft:4}}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></span>}</button>
  );
}

function Shell({ bg, overlay, children }) {
  return (
    <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column" }}>
      <img src={bg} alt="" style={{ position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",objectPosition:"center top" }}/>
      <div style={{ position:"absolute",inset:0,background:overlay,pointerEvents:"none" }}/>
      <div style={{ position:"relative",flex:1,display:"flex",flexDirection:"column",minHeight:0,zIndex:1 }}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── NEW INNER PAGE: FITNESS STATS ────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Real week data — current date: April 29, 2026 (Wednesday)
const WEEKS_DATA = [
  // 0 = current (Apr 27 – May 3), higher index = older
  { label:"Apr 27 – May 3", days:[{day:"Mon",cal:380,type:"strength"},{day:"Tue",cal:320,type:"hiit"},{day:"Wed",cal:410,type:"strength"},{day:"Thu",cal:0,type:"rest"},{day:"Fri",cal:0,type:"rest"},{day:"Sat",cal:0,type:"rest"},{day:"Sun",cal:0,type:"rest"}], bestDays:[{day:"Thursday",type:"Strength",cal:410},{day:"Monday",type:"Strength",cal:380}], improvement:"N/A" },
  { label:"Apr 20 – 26",    days:[{day:"Mon",cal:350,type:"strength"},{day:"Tue",cal:0,type:"rest"},{day:"Wed",cal:450,type:"hiit"},{day:"Thu",cal:320,type:"hiit"},{day:"Fri",cal:400,type:"strength"},{day:"Sat",cal:0,type:"rest"},{day:"Sun",cal:380,type:"cardio"}], bestDays:[{day:"Wednesday",type:"HIIT",cal:450},{day:"Friday",type:"Strength",cal:400}], improvement:"12%" },
  { label:"Apr 13 – 19",    days:[{day:"Mon",cal:380,type:"strength"},{day:"Tue",cal:290,type:"cardio"},{day:"Wed",cal:0,type:"rest"},{day:"Thu",cal:410,type:"strength"},{day:"Fri",cal:350,type:"hiit"},{day:"Sat",cal:300,type:"cardio"},{day:"Sun",cal:0,type:"rest"}], bestDays:[{day:"Thursday",type:"Strength",cal:410},{day:"Monday",type:"Strength",cal:380}], improvement:"8%" },
];

function FitnessStatsPage({ onBack }) {
  const { isPremium, setIsPremium } = useUser();
  const statsScrollRef = useScrollPos("fitness-stats");
  const [week, setWeek]     = useState(0); // 0 = current week, cannot go below 0
  const [dir, setDir]       = useState(0); // -1 left, 1 right for animation
  const [animKey, setAnimKey] = useState(0);
  const touchStartX = useRef(null);
  const MAX_WEEK = WEEKS_DATA.length - 1;

  const goTo = (next) => {
    if (next < 0 || next > MAX_WEEK) return; // boundary guard
    if (!isPremium && next > 0) { setIsPremium(true); return; } // older weeks = premium only
    setDir(next > week ? -1 : 1);
    setAnimKey(k => k + 1);
    setWeek(next);
  };

  const onTouchStart = e => { touchStartX.current = e.touches[0].clientX; };
  const onTouchEnd   = e => {
    if (!touchStartX.current) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 50) dx < 0 ? goTo(week + 1) : goTo(week - 1);
    touchStartX.current = null;
  };

  const w = WEEKS_DATA[week];
  const calDays  = w.days.filter(d => d.cal > 0);
  const maxCal   = Math.max(...w.days.map(d => d.cal), 1);
  const minCal   = Math.min(...calDays.map(d => d.cal));
  const totalCal = calDays.reduce((s,d) => s + d.cal, 0);
  const avgCal   = calDays.length ? Math.round(totalCal / calDays.length) : 0;

  const barH = (cal) => {
    if (!cal) return 0;
    // Proportional to actual value — 450 cal = visually taller than 350 cal
    const MAX_H = 100;
    return Math.max(12, (cal / (maxCal || 1)) * MAX_H);
  };

  const slideAnim = dir === 0 ? {} : {
    animation: `${dir > 0 ? "slideInFromRight" : "slideInFromLeft"} 0.3s ease both`
  };

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <BackHeader title="FITNESS STATS" onBack={onBack}
        right={<div style={{width:40,height:40,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>}
      />

      {/* Week selector with swipe zone */}
      <div style={{ padding:"0 16px",flexShrink:0 }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>

        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:22,color:"#fff",key:week }}>{w.label}</div>
          <div style={{ display:"flex",alignItems:"center",gap:6 }}>
            {/* Dots indicator */}
            <div style={{ display:"flex",gap:5,marginRight:8 }}>
              {WEEKS_DATA.map((_,i)=>(
                <div key={i} style={{ width:i===week?18:6,height:6,borderRadius:3,background:i===week?PRIMARY:"#2a2a2a",transition:"all 0.2s" }}/>
              ))}
            </div>
            <button onClick={()=>goTo(week+1)} disabled={week>=MAX_WEEK}
              style={{width:36,height:36,borderRadius:"50%",background:week>=MAX_WEEK?"#111":CARD,border:`1px solid ${week>=MAX_WEEK?"#1a1a1a":BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:week>=MAX_WEEK?"not-allowed":"pointer",transition:"all 0.2s"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={week>=MAX_WEEK?"#333":"#888"} strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button onClick={()=>goTo(week-1)} disabled={week<=0}
              style={{width:36,height:36,borderRadius:"50%",background:week<=0?"#111":CARD,border:`1px solid ${week<=0?"#1a1a1a":BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:week<=0?"not-allowed":"pointer",transition:"all 0.2s"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={week<=0?"#333":"#888"} strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>

        {/* Swipe hint */}
        <div style={{ fontFamily:FONT,fontSize:10,color:"#2a2a2a",marginBottom:14,textAlign:"center",letterSpacing:0.5 }}>
          {week===0 ? "Swipe right for previous weeks" : week===MAX_WEEK ? "This is your oldest week" : "Swipe to change week"}
        </div>
      </div>

      {/* Swipeable content */}
      <div key={animKey} ref={statsScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 40px",...slideAnim }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>

        {/* Bar chart */}
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px 16px",marginBottom:14 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18 }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff" }}>Weekly Progress</div>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:PRIMARY }}>{calDays.length}/7 days</div>
          </div>
          <div style={{ display:"flex",gap:4,alignItems:"flex-end",marginBottom:6 }}>
            {w.days.map((d,i)=>{
              const hpx = d.cal>0 ? Math.max(10, Math.round((d.cal/(maxCal||1))*100)) : 4;
              const col = d.cal>0 ? (TYPE_COLOR[d.type]||"#374151") : "#2a2a2a";
              return (
                <div key={i} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3 }}>
                  <div style={{ fontFamily:FONT,fontSize:8,color:d.cal>0?"#aaa":"transparent",fontWeight:600 }}>{d.cal||""}</div>
                  <div style={{ width:"100%",height:hpx+"px",background:col,borderRadius:"4px 4px 0 0" }}/>
                  <div style={{ fontFamily:FONT,fontSize:10,color:"#666" }}>{d.day}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display:"flex",gap:14,marginTop:16,flexWrap:"wrap" }}>
            {[["#00A3FF","Strength"],["#F59E0B","Cardio"],["#6366F1","HIIT"],["#6B7280","Rest Day"]].map(([c,l])=>(
              <div key={l} style={{ display:"flex",alignItems:"center",gap:6 }}>
                <div style={{ width:10,height:10,borderRadius:"50%",background:c }}/>
                <span style={{ fontFamily:FONT,fontSize:11,color:"#aaa" }}>{l}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stat grid */}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12 }}>
          {[
            { iconBg:"#DC2626", label:"Average Calories",   val:avgCal,         svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
            { iconBg:"#6366F1", label:"Workouts This Week", val:calDays.length, svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg> },
            { iconBg:"#16A34A", label:"Avg Minutes",        val:60,             svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
            { iconBg:"#9333EA", label:"Weekly Improvement", val:w.improvement,  svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg> },
          ].map((s,i)=>(
            <div key={i} style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"24px 16px",display:"flex",flexDirection:"column",alignItems:"center",gap:12 }}>
              <div style={{ width:44,height:44,borderRadius:"50%",background:s.iconBg,display:"flex",alignItems:"center",justifyContent:"center" }}>{s.svg}</div>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:32,color:"#fff",lineHeight:1 }}>{s.val}</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",textAlign:"center",lineHeight:1.4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Best days */}
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"16px 18px" }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888",marginBottom:12,letterSpacing:1 }}>THIS WEEK'S BEST DAYS</div>
          {w.bestDays.map((r,i)=>(
            <div key={i} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",paddingBottom:i===0&&w.bestDays.length>1?14:0,borderBottom:i===0&&w.bestDays.length>1?`1px solid ${BORDER}`:0,marginBottom:i===0&&w.bestDays.length>1?14:0 }}>
              <div>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff" }}>{r.day}</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{r.type}</div>
              </div>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#FF6B35" }}>{r.cal} <span style={{fontSize:13,fontWeight:600,color:"#888888"}}>cal</span></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── NEW INNER PAGE: RECIPE / NUTRITION ───────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ── RECIPE FULL PAGE ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function RecipeFullPage({ recipe, r, isSaved, saved, onSave, onToggleSave, onBack }) {
  const meal  = recipe || r;
  const isS   = isSaved !== undefined ? isSaved : (saved || false);
  const doSave = onSave || onToggleSave || (()=>{});
  const [checked,    setChecked]    = useState([]);
  const [rating,     setRating]     = useState(0);
  const [hovered,    setHovered]    = useState(0);
  const [rated,      setRated]      = useState(false);
  const [showRating, setShowRating] = useState(false);
  if (!meal) return null;
  const toggle = (i) => setChecked(p => p.includes(i) ? p.filter(x=>x!==i) : [...p,i]);
  const handleRate = (star) => { setRating(star); setRated(true); setTimeout(()=>setShowRating(false),1400); };
  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <BackHeader title="RECIPE" onBack={onBack}
        right={
          <button onClick={doSave} style={{ width:40,height:40,borderRadius:"50%",background:isS?`${PRIMARY}22`:CARD,border:`1px solid ${isS?PRIMARY:BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill={isS?PRIMARY:"none"} stroke={isS?PRIMARY:"#888"} strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
          </button>
        }
      />
      <div style={{ flex:1,overflowY:"auto" }}>
        <div style={{ position:"relative",height:220 }}>
          <img src={meal.img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
          <div style={{ position:"absolute",inset:0,background:"linear-gradient(180deg,transparent 30%,rgba(0,0,0,0.75) 100%)" }}/>
          <div style={{ position:"absolute",bottom:16,left:18 }}>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",lineHeight:1.2,marginBottom:6 }}>{meal.name}</div>
            <div style={{ display:"flex",gap:16 }}>
              <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.9)",fontWeight:600 }}>{meal.mins} min</span>
              </div>
              {meal.servings&&<div style={{ display:"flex",alignItems:"center",gap:5 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                <span style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.9)",fontWeight:600 }}>{meal.servings} servings</span>
              </div>}
            </div>
          </div>
        </div>
        <div style={{ padding:"0 16px 40px" }}>
          {meal.desc&&<div style={{ background:"#fff",borderRadius:16,padding:"16px 18px",marginTop:16,marginBottom:14 }}>
            <p style={{ fontFamily:FONT,fontSize:13.5,color:"#222",lineHeight:1.65,margin:0 }}>{meal.desc}</p>
          </div>}
          <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14 }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:16 }}>Nutritional Value</div>
            <div style={{ display:"flex",justifyContent:"space-around" }}>
              {[{ltr:"C",label:"Calories",val:meal.cal,bg:"#EA580C"},{ltr:"P",label:"Protein",val:`${meal.protein}g`,bg:"#DC2626"},{ltr:"F",label:"Fats",val:`${meal.fats}g`,bg:"#16A34A"},{ltr:"W",label:"Carbs",val:`${meal.carbs}g`,bg:"#0EA5E9"}].map(s=>(
                <div key={s.ltr} style={{ textAlign:"center" }}>
                  <div style={{ width:50,height:50,borderRadius:"50%",background:s.bg,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 8px",fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff" }}>{s.ltr}</div>
                  <div style={{ fontFamily:FONT,fontSize:11,color:"#888",marginBottom:2 }}>{s.label}</div>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:s.bg }}>{s.val}</div>
                </div>
              ))}
            </div>
          </div>
          {meal.ingredients&&meal.ingredients.length>0&&(
            <div style={{ background:"#fff",borderRadius:20,padding:"18px",marginBottom:14 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#111",marginBottom:14 }}>Ingredients</div>
              {meal.ingredients.map((ing,i)=>(
                <div key={i} onClick={()=>toggle(i)} style={{ display:"flex",alignItems:"center",gap:14,padding:"10px 0",borderBottom:i<meal.ingredients.length-1?"1px solid #eee":"none",cursor:"pointer" }}>
                  <div style={{ width:22,height:22,borderRadius:4,border:`2px solid ${checked.includes(i)?PRIMARY:"#ccc"}`,background:checked.includes(i)?PRIMARY:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s" }}>
                    {checked.includes(i)&&<svg width="12" height="9" viewBox="0 0 12 9" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="1,4.5 4.5,8 11,1"/></svg>}
                  </div>
                  <span style={{ fontFamily:FONT,fontSize:14,color:checked.includes(i)?"#aaa":"#222",textDecoration:checked.includes(i)?"line-through":"none" }}>{ing}</span>
                </div>
              ))}
            </div>
          )}
          {meal.steps&&meal.steps.length>0&&(
            <div style={{ background:"#fff",borderRadius:20,padding:"18px",marginBottom:16 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#111",marginBottom:14 }}>Directions</div>
              {meal.steps.map((s,i)=>(
                <div key={i} style={{ marginBottom:14 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#111",marginBottom:4 }}>Step {i+1}</div>
                  <div style={{ fontFamily:FONT,fontSize:13.5,color:"#444",lineHeight:1.65,paddingLeft:12 }}>{typeof s==="string"?s:(s.body||s.title||"")}</div>
                </div>
              ))}
            </div>
          )}
          {rated?(
            <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 20px",display:"flex",alignItems:"center",gap:14 }}>
              <div style={{ display:"flex",gap:3 }}>{[1,2,3,4,5].map(s=><svg key={s} width="18" height="18" viewBox="0 0 24 24" fill={s<=rating?"#F59E0B":"#333"}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>)}</div>
              <div style={{ flex:1 }}><div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#22C55E" }}>Thanks for rating!</div></div>
            </div>
          ):(
            <button onClick={()=>setShowRating(true)} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1.5,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:`0 4px 24px ${PRIMARY}55` }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              Rate this Recipe
            </button>
          )}
        </div>
      </div>
      {showRating&&(
        <>
          <div onClick={()=>setShowRating(false)} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.75)",zIndex:50 }}/>
          <div style={{ position:"absolute",bottom:0,left:0,right:0,background:CARD,borderRadius:"24px 24px 0 0",border:`1px solid ${BORDER}`,borderBottom:"none",padding:"24px 24px 44px",zIndex:51 }}>
            <div style={{ display:"flex",justifyContent:"center",marginBottom:12 }}><div style={{ width:40,height:4,borderRadius:2,background:"#2a2a2a" }}/></div>
            <button onClick={()=>setShowRating(false)} style={{ position:"absolute",top:20,right:20,width:32,height:32,borderRadius:"50%",background:"#1e1e1e",border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div style={{ textAlign:"center",marginBottom:20 }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff",marginBottom:4 }}>Rate this Recipe</div>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:PRIMARY }}>{meal.name}</div>
            </div>
            <div style={{ display:"flex",justifyContent:"center",gap:12,marginBottom:8 }}>
              {[1,2,3,4,5].map(star=>(
                <button key={star} onMouseEnter={()=>setHovered(star)} onMouseLeave={()=>setHovered(0)} onClick={()=>handleRate(star)}
                  style={{ background:"none",border:"none",cursor:"pointer",transform:hovered>=star?"scale(1.2)":"scale(1)",transition:"transform 0.15s",padding:0 }}>
                  <svg width="44" height="44" viewBox="0 0 24 24" fill={hovered>=star?"#F59E0B":"#2a2a2a"} stroke={hovered>=star?"#F59E0B":"#444"} strokeWidth="1.5">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NutritionPage({ meal, onBack }) {
  // Convert MEALS format to RecipeFullPage-compatible format
  const recipe = {
    ...meal,
    id: 0,
    tag: meal.tag || "Meal of the Day",
    cat: [meal.goal || "Balanced"],
    steps: meal.steps || [],
    ingredients: meal.ingredients || [],
  };
  return (
    <RecipeFullPage
      recipe={recipe}
      isSaved={false}
      onSave={()=>{}}
      onBack={onBack}
    />
  );
}



// -- WorkoutCompleteScreen
function WorkoutCompleteScreen({ workout, onDone, onViewAI, streakDay }) {
  const [show, setShow] = useState(false);
  const { isPremium } = useUser();
  useEffect(() => { const t = setTimeout(() => setShow(true), 80); return () => clearTimeout(t); }, []);
  const stats = [
    { label:"Exercises", value: workout ? workout.exercises : 0, color:"#00A3FF" },
    { label:"Calories",  value: workout ? workout.cal : 0, color:"#EF4444" },
    { label:"Duration",  value: (workout ? workout.mins : 0) + " min", color:"#22C55E" },
  ];
  const milestones = [3,7,14,30];
  const isMilestone = milestones.includes(streakDay);
  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:28,zIndex:200 }}>
      {show && Array.from({length:16}).map((_,i)=>(
        <div key={i} style={{ position:"absolute",top:(5+Math.random()*55)+"%",left:(Math.random()*100)+"%",width:6+Math.random()*6,height:6+Math.random()*6,borderRadius:Math.random()>0.5?"50%":"2px",background:["#00A3FF","#22C55E","#F59E0B","#EF4444","#8B5CF6"][i%5],opacity:0.7 }}/>
      ))}
      <div style={{ width:90,height:90,borderRadius:"50%",background:"rgba(0,163,255,0.12)",border:"2px solid rgba(0,163,255,0.4)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:24 }}>
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="1.5">
          <path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/>
          <path d="M4 22h16"/>
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
          <path d="M18 2H6v7a6 6 0 0012 0V2z"/>
        </svg>
      </div>
      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:"#fff",marginBottom:8,textAlign:"center",lineHeight:1.2 }}>
        {isMilestone ? "Day "+streakDay+" Streak!" : "Workout Complete!"}
      </div>
      {isMilestone && (
        <div style={{ background:"rgba(0,163,255,0.1)",border:"1px solid rgba(0,163,255,0.3)",borderRadius:14,padding:"10px 20px",marginBottom:14,textAlign:"center" }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:PRIMARY }}>
            {streakDay===3?"Building momentum. Keep going.":streakDay===7?"One full week. Real habits form here.":streakDay===14?"Two weeks in. This is who you are now.":"30 days. Top 6% of all users."}
          </div>
        </div>
      )}
      <div style={{ fontFamily:FONT,fontSize:13,color:"#888",marginBottom:28,textAlign:"center" }}>
        {isMilestone?"Your streak is protected.":"Great work. Every session counts."}
      </div>
      <div style={{ display:"flex",gap:10,marginBottom:28,width:"100%" }}>
        {stats.map((s,i)=>(
          <div key={i} style={{ flex:1,background:CARD,borderRadius:16,border:"1px solid "+BORDER,padding:"14px 8px",textAlign:"center" }}>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:s.color,marginBottom:4 }}>{s.value}</div>
            <div style={{ fontFamily:FONT,fontSize:10,color:"#666",letterSpacing:0.5 }}>{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>
      <button onClick={onViewAI} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:"pointer",marginBottom:12,boxShadow:"0 4px 24px rgba(0,163,255,0.4)" }}>
        {isPremium?"View AI Analysis":"View AI Analysis (Preview)"}
      </button>
      <button onClick={onDone} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:"transparent",border:"1.5px solid "+BORDER,fontFamily:FONT,fontWeight:700,fontSize:14,color:"#888",cursor:"pointer" }}>
        Back to Home
      </button>
    </div>
  );
}


function AiTipIcon({ type }) {
  const s = { width:14, height:14, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:"2" };
  if (type==="clock")     return <svg {...s}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
  if (type==="target")    return <svg {...s}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>;
  if (type==="muscle")    return <svg {...s}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (type==="lightbulb") return <svg {...s}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17H8v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function WorkoutDetailPage({ workout, onBack, onComplete, onExercise, completedExercises=[] }) {
  const wdpScrollRef = useScrollPos("workout-detail");
  const [started, setStarted]         = useState(false);
  const [paused,  setPaused]          = useState(false);
  const [completedEx, setCompletedEx] = useState([]);
  const [elapsed, setElapsed]         = useState(0);
  const timerRef                      = useRef(null);

  // Timer: start/pause/stop
  useEffect(() => {
    if (started && !paused) {
      timerRef.current = setInterval(() => setElapsed(t => t + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [started, paused]);

  const fmt = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  const toggleEx = (i) => setCompletedEx(p => p.includes(i) ? p.filter(x=>x!==i) : [...p,i]);
  const allDone = completedEx.length === EXERCISES.length;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* ── HEADER with live timer + pause/play ── */}
      <div style={{ padding:"50px 18px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,background:BG }}>
        <button onClick={onBack} style={{ width:38,height:38,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>

        {/* Title + timer */}
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>WORKOUT</div>
          {started && (
            <div style={{ display:"flex",alignItems:"center",gap:8,justifyContent:"center",marginTop:4 }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:paused?"#888":PRIMARY,letterSpacing:3,transition:"color 0.2s" }}>{fmt(elapsed)}</div>
              {paused && <span style={{ fontFamily:FONT,fontSize:10,color:"#888888",letterSpacing:1 }}>PAUSED</span>}
            </div>
          )}
        </div>

        {/* Pause/Play button — only when started */}
        {started && !allDone ? (
          <button onClick={()=>setPaused(p=>!p)}
            style={{ width:42,height:42,borderRadius:"50%",background:paused?`${PRIMARY}22`:CARD,border:`2px solid ${paused?PRIMARY:BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"all 0.2s" }}>
            {paused
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill={PRIMARY}><polygon points="5 3 19 12 5 21 5 3"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="#aaa"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            }
          </button>
        ) : (
          <div style={{ width:42,height:42,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>
          </div>
        )}
      </div>

      <div style={{ flex:1,overflowY:"auto",paddingBottom:90 }}>
        {/* Summary card */}
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,margin:"0 16px 16px",padding:"20px" }}>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff",textAlign:"center",marginBottom:6 }}>Today's Workout</div>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#aaa",textAlign:"center",marginBottom:18 }}>{workout.name}</div>
          <div style={{ display:"flex",justifyContent:"space-around" }}>
            {[
              {val:workout.exercises,lbl:"Exercises",col:"#FF6B35",svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF6B35" strokeWidth="2"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>},
              {val:workout.cal,lbl:"Calories",col:"#EF4444",svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="#EF4444"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>},
              {val:workout.mins,lbl:"Minutes",col:"#22C55E",svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>},
            ].map(s=>(
              <div key={s.lbl} style={{ textAlign:"center" }}>
                <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:5,marginBottom:4 }}>
                  {s.svg}
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:s.col,lineHeight:1 }}>{s.val}</div>
                </div>
                <div style={{ fontFamily:FONT,fontSize:11,color:"#888888",letterSpacing:0.5 }}>{s.lbl}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Exercise list */}
        <div style={{ padding:"0 16px" }}>
          {EXERCISES.map((ex,i)=>{
            const done = completedEx.includes(i) || completedExercises.includes(ex.name);
            const skipped = completedEx.includes(`skip_${i}`);
            return (
              <div key={i} style={{ background:"#fff",borderRadius:18,marginBottom:12,overflow:"hidden",border:done?`2px solid #22C55E`:skipped?`2px solid #F9731633`:`2px solid transparent`,transition:"border-color 0.2s" }}>
                <div style={{ display:"flex",alignItems:"center" }}>
                  {/* Thumb */}
                  <div onClick={()=>onExercise&&onExercise(ex)} style={{ position:"relative",width:90,height:90,flexShrink:0,cursor:"pointer" }}>
                    <img src={ex.img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                    <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.2)",display:"flex",alignItems:"center",justifyContent:"center" }}>
                      <div style={{ width:36,height:36,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 0 12px ${PRIMARY}99` }}>
                        <svg width="11" height="13" viewBox="0 0 11 13" fill="white"><polygon points="0,0 11,6.5 0,13"/></svg>
                      </div>
                    </div>
                  </div>
                  {/* Info */}
                  <div onClick={()=>onExercise&&onExercise(ex)} style={{ flex:1,padding:"12px 10px",cursor:"pointer" }}>
                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#111",marginBottom:2 }}>{ex.name}</div>
                    <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginBottom:3 }}>{ex.sets} sets × {ex.reps} reps</div>
                    <div style={{ fontFamily:FONT,fontSize:11,color:PRIMARY }}>{ex.muscles}</div>
                    {skipped && <div style={{ fontFamily:FONT,fontSize:10,color:"#F97316",marginTop:2,fontWeight:600 }}>Skipped</div>}
                  </div>
                  {/* Action buttons */}
                  <div style={{ padding:"0 12px 0 4px",display:"flex",flexDirection:"column",gap:6,alignItems:"center" }}>
                    {/* Complete / done */}
                    <button onClick={(e)=>{e.stopPropagation(); if(!skipped) toggleEx(i);}}
                      style={{ width:34,height:34,borderRadius:"50%",background:done?"#22C55E":PRIMARY,border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"background 0.2s",opacity:skipped?0.3:1 }}>
                      <svg width="14" height="11" viewBox="0 0 14 11" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="1,5.5 5,9.5 13,1"/></svg>
                    </button>
                    {/* Skip this exercise */}
                    {!done && (
                      <button onClick={(e)=>{e.stopPropagation(); setCompletedEx(p => p.includes(`skip_${i}`) ? p.filter(x=>x!==`skip_${i}`) : [...p,`skip_${i}`]);}}
                        style={{ width:34,height:34,borderRadius:"50%",background:skipped?"#F9731633":"#f5f5f5",border:`1px solid ${skipped?"#F97316":"#e0e0e0"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"all 0.2s" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={skipped?"#F97316":"#aaa"} strokeWidth="2.5"><polyline points="5 12 19 12"/><polyline points="13 6 19 12 13 18"/></svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom CTA */}
      <div style={{ position:"absolute",bottom:0,left:0,right:0,padding:"12px 16px 28px",background:BG,borderTop:`1px solid ${BORDER}` }}>
        {!started ? (
          <button onClick={()=>setStarted(true)} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:`0 4px 28px ${PRIMARY}55` }}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="white"><polygon points="0,0 13,6.5 0,13"/></svg>
            START WORKOUT
          </button>
        ) : allDone ? (
          <button onClick={onComplete} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:"linear-gradient(135deg,#22C55E,#16A34A)",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",boxShadow:"0 4px 24px rgba(34,197,94,0.5)" }}>
            COMPLETE WORKOUT
          </button>
        ) : (
          <div style={{ background:"#111",borderRadius:50,padding:"14px 18px",textAlign:"center" }}>
            <span style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888" }}>{completedEx.filter(x=>!String(x).startsWith("skip_")).length}/{EXERCISES.length} exercises done</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── SWIPEABLE SET ROW ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function SwipeableSet({ set:s, index:i, activeSet, onUpdate, onComplete, onDelete }) {
  const [offsetX, setOffsetX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startX = useRef(null);
  const THRESHOLD = 80;

  const onTouchStart = e => { startX.current = e.touches[0].clientX; setSwiping(true); };
  const onTouchMove  = e => {
    if (!startX.current) return;
    const dx = e.touches[0].clientX - startX.current;
    if (dx < 0) setOffsetX(Math.max(dx, -120));
  };
  const onTouchEnd = () => {
    setSwiping(false);
    if (offsetX < -THRESHOLD && onDelete) { onDelete(); }
    else setOffsetX(0);
    startX.current = null;
  };

  const revealed = offsetX < -THRESHOLD / 2;

  return (
    <div style={{ position:"relative",marginBottom:10,borderRadius:14,overflow:"hidden" }}>
      {/* Delete reveal */}
      <div style={{ position:"absolute",right:0,top:0,bottom:0,width:80,background:"#EF4444",display:"flex",alignItems:"center",justifyContent:"center",borderRadius:"0 14px 14px 0",opacity:onDelete?1:0 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </div>

      {/* Set card */}
      <div
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ background:s.done?"#0c1c0c":i===activeSet?"#0d1a2e":"#111",border:`1.5px solid ${s.done?"#22C55E44":i===activeSet?`${PRIMARY}44`:"transparent"}`,borderRadius:14,padding:"14px 16px",transform:`translateX(${offsetX}px)`,transition:swiping?"none":"transform 0.3s ease",userSelect:"none",touchAction:"pan-y" }}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ flexShrink:0,width:52 }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:s.done?"#22C55E":i===activeSet?"#fff":"#444" }}>Set {i+1}</div>
            <div style={{ fontFamily:FONT,fontSize:10,color:"#444",marginTop:1 }}>8–12 reps</div>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",marginBottom:4,letterSpacing:0.5 }}>Weight (lbs)</div>
            <input type="text" inputMode="decimal" pattern="[0-9]*\.?[0-9]*" placeholder="—" value={s.weight} onChange={e=>onUpdate("weight",e.target.value)} disabled={s.done}
              style={{ width:"100%",background:s.done?"rgba(34,197,94,0.08)":"rgba(255,255,255,0.06)",border:`1px solid ${s.done?"#22C55E33":i===activeSet?`${PRIMARY}55`:"#2a2a2a"}`,borderRadius:10,padding:"10px 12px",fontFamily:FONT,fontWeight:700,fontSize:16,color:s.done?"#22C55E":"#fff",outline:"none",textAlign:"center" }}/>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",marginBottom:4,letterSpacing:0.5 }}>Reps</div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" placeholder="—" value={s.reps} onChange={e=>onUpdate("reps",e.target.value)} disabled={s.done}
              style={{ width:"100%",background:s.done?"rgba(34,197,94,0.08)":"rgba(255,255,255,0.06)",border:`1px solid ${s.done?"#22C55E33":i===activeSet?`${PRIMARY}55`:"#2a2a2a"}`,borderRadius:10,padding:"10px 12px",fontFamily:FONT,fontWeight:700,fontSize:16,color:s.done?"#22C55E":"#fff",outline:"none",textAlign:"center" }}/>
          </div>
          <button onClick={onComplete} disabled={s.done}
            style={{ width:44,height:44,borderRadius:"50%",background:s.done?"#22C55E":i===activeSet?PRIMARY:"#1a1a1a",border:`2px solid ${s.done?"#22C55E":i===activeSet?PRIMARY:"#333"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:s.done?"default":"pointer",flexShrink:0,transition:"all 0.2s",boxShadow:s.done?"0 0 12px rgba(34,197,94,0.4)":i===activeSet?`0 0 12px ${PRIMARY}44`:"none" }}>
            {s.done
              ? <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="1,7 6,12 17,1"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
          </button>
        </div>
        {/* Swipe hint — only on first extra set */}
        {onDelete && !s.done && (
          <div style={{ display:"flex",alignItems:"center",gap:4,marginTop:6,justifyContent:"flex-end" }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            <span style={{ fontFamily:FONT,fontSize:10,color:"#333",letterSpacing:0.5 }}>swipe left to delete</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── NEW INNER PAGE: EXERCISE DETAIL ──────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function ExercisePage({ exercise, onBack, onComplete, workoutElapsed=0, workoutFmt, onAutoStartWorkout }) {
  const exScrollRef = useScrollPos("exercise-" + (exercise?.name||""));
  const ex = exercise || EXERCISES[0];
  const [sets, setSets] = useState([{reps:"",weight:"",done:false},{reps:"",weight:"",done:false}]);
  const MIN_SETS = 2; // first 2 sets cannot be deleted
  const [started, setStarted] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(true);
  const [instructOpen, setInstructOpen] = useState(false);
  const [activeSet, setActiveSet] = useState(0);
  const [restTimer, setRestTimer] = useState(null);
  const [restCount, setRestCount] = useState(0);
  const timerRef = useRef(null);

  const completedSets = sets.filter(s=>s.done).length;
  const allDone = completedSets === sets.length;

  // Can only mark set done if weight AND reps are filled
  const canComplete = (i) => {
    const s = sets[i];
    return s && String(s.weight).trim() !== "" && String(s.reps).trim() !== "";
  };

  const markSetDone = (i) => {
    if (!canComplete(i)) return; // guard: must have weight + reps
    // Auto-start workout timer on first logged set if not already running
    if (onAutoStartWorkout) onAutoStartWorkout();
    const updated = sets.map((s,idx)=> idx===i ? {...s, done:true} : s);
    setSets(updated);
    setActiveSet(Math.min(i+1, sets.length-1));
    // start rest timer
    setRestCount(90);
    setRestTimer(true);
    if(timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(()=>{
      setRestCount(c=>{ if(c<=1){ clearInterval(timerRef.current); setRestTimer(false); return 0; } return c-1; });
    },1000);
  };

  const addSet = () => setSets(s=>[...s,{reps:"",weight:"",done:false}]);

  const updateSet = (i,field,val) => setSets(s=>s.map((x,idx)=>idx===i?{...x,[field]:val}:x));

  const instructions = [
    "Lie flat on the bench with feet firmly on the floor",
    "Hold dumbbells at chest level, elbows at 45°",
    "Take a deep breath and press upward until arms are fully extended",
    "Pause briefly at the top — squeeze your chest",
    "Lower the weight slowly (3 seconds down) — control is key",
    "Return to start position and repeat",
  ];

  const aiTips = [
    { icon:"clock", label:"Rest Time", value:"60–90 seconds between sets", color:"#00A3FF" },
    { icon:"target", label:"Focus",     value:"Control the weight on the way down", color:"#22C55E" },
    { icon:"muscle", label:"Tip",       value:"Keep your feet planted for stability", color:"#F97316" },
    { icon:"lightbulb", label:"Beginner",  value:"Start light — master form before adding weight", color:"#8B5CF6" },
  ];

  const progressPct = (completedSets / sets.length) * 100;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* ── HEADER ── */}
      <div style={{ padding:"50px 18px 10px",display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#fff",fontSize:20,marginTop:2 }}>‹</button>
        <div style={{ flex:1,textAlign:"center",padding:"0 12px" }}>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff" }}>{ex.name}</div>
          <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:3 }}>Chest · Strength · Beginner-friendly</div>
        </div>
        <div style={{ width:36 }}/>
      </div>

      {/* ── SCROLL BODY ── */}
      <div style={{ flex:1,overflowY:"auto",paddingBottom:100 }}>

        {/* ── VIDEO PLAYER ── */}
        <div style={{ position:"relative",width:"100%",height:210,background:"#000",overflow:"hidden" }}>
          <img src="https://images.unsplash.com/photo-1517963879433-6ad2b056d712?w=600&q=80"
            alt="" style={{ width:"100%",height:"100%",objectFit:"cover",filter:"brightness(0.75)" }}/>
          <div style={{ position:"absolute",inset:0,background:"linear-gradient(180deg,transparent 40%,rgba(0,0,0,0.7) 100%)" }}/>
          {/* Play button */}
          <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <div style={{ width:60,height:60,borderRadius:"50%",background:"rgba(0,163,255,0.9)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 30px rgba(0,163,255,0.7)",cursor:"pointer" }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="white"><polygon points="4,2 20,11 4,20"/></svg>
            </div>
          </div>
          {/* Labels */}
          <div style={{ position:"absolute",bottom:14,left:16,display:"flex",gap:8 }}>
            <div style={{ background:"rgba(0,163,255,0.85)",borderRadius:20,padding:"4px 12px" }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#fff",letterSpacing:1 }}>DEMO · 30s LOOP</span>
            </div>
            <div style={{ background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"4px 12px",border:"1px solid rgba(255,255,255,0.2)" }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#fff" }}>Fullscreen</span>
            </div>
          </div>
          {/* Timer top-right */}
          <div style={{ position:"absolute",top:14,right:16 }}>
            <div style={{ background:"rgba(0,0,0,0.6)",borderRadius:20,padding:"5px 14px",border:"1px solid rgba(255,255,255,0.15)" }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#fff" }}>00:00</span>
            </div>
          </div>
        </div>

        <div style={{ padding:"16px 16px 0" }}>

          {/* ── REST TIMER ── */}
          {restTimer && (
            <div style={{ background:"linear-gradient(135deg,#00A3FF,#0068CC)",borderRadius:16,padding:"14px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:14,animation:"fadeUp 0.3s ease both" }}>
              <div style={{ width:50,height:50,borderRadius:"50%",background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                <span style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff" }}>{restCount}</span>
              </div>
              <div>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",marginBottom:2 }}>Rest Time</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.8)" }}>Take adequate rest between sets for optimal performance</div>
              </div>
            </div>
          )}

          {/* ── AI SMART TIPS ── */}
          <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,marginBottom:14,overflow:"hidden" }}>
            <button onClick={()=>setTipsOpen(o=>!o)} style={{ width:"100%",padding:"14px 18px",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
              <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                <div style={{ width:34,height:34,borderRadius:10,background:"linear-gradient(135deg,#6D28D9,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16 }}><svg width="12" height="12" viewBox="0 0 24 24" fill="#00A3FF" stroke="none"><polygon points="12 2 13.5 10.5 22 12 13.5 13.5 12 22 10.5 13.5 2 12 10.5 10.5 12 2"/></svg></div>
                <div style={{ textAlign:"left" }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#8B5CF6",letterSpacing:1.5 }}>VTRXAI</div>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff" }}>Smart Tips</div>
                </div>
              </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" style={{ transform:tipsOpen?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.25s" }}><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            {tipsOpen && (
              <div style={{ padding:"0 16px 16px",display:"flex",flexDirection:"column",gap:10,animation:"fadeUp 0.25s ease both" }}>
                {aiTips.map((t,i)=>(
                  <div key={i} style={{ display:"flex",alignItems:"center",gap:12,background:"#1a1a1a",borderRadius:12,padding:"12px 14px",border:`1px solid ${BORDER}` }}>
                    <div style={{ width:36,height:36,borderRadius:10,background:`${t.color}18`,border:`1px solid ${t.color}44`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:t.color }}><AiTipIcon type={t.icon}/></div>
                    <div>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:t.color,letterSpacing:1,marginBottom:2 }}>{t.label.toUpperCase()}</div>
                      <div style={{ fontFamily:FONT,fontSize:13,color:"rgba(255,255,255,0.8)" }}>{t.value}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── PROGRESS BAR ── */}
          <div style={{ background:CARD,borderRadius:16,border:`1px solid ${BORDER}`,padding:"14px 18px",marginBottom:14 }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>Sets Progress</div>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:PRIMARY }}>{completedSets}/{sets.length} sets</div>
            </div>
            <div style={{ height:8,background:"#222",borderRadius:8,overflow:"hidden" }}>
              <div style={{ height:"100%",width:`${progressPct}%`,background:`linear-gradient(90deg,${PRIMARY},#22C55E)`,borderRadius:8,transition:"width 0.6s ease" }}/>
            </div>
            <div style={{ display:"flex",justifyContent:"space-between",marginTop:8 }}>
              {sets.map((_,i)=>(
                <div key={i} style={{ flex:1,textAlign:"center" }}>
                  <div style={{ width:10,height:10,borderRadius:"50%",background:sets[i].done?"#22C55E":i===activeSet?PRIMARY:"#2a2a2a",margin:"0 auto",border:`1.5px solid ${sets[i].done?"#22C55E":i===activeSet?PRIMARY:"#333"}`,transition:"all 0.3s" }}/>
                </div>
              ))}
            </div>
          </div>

          {/* ── LOGGING SECTION ── */}
          <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px",marginBottom:14 }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff" }}>Log Your Sets</div>
              <div style={{ fontFamily:FONT,fontSize:11,color:"#888888" }}>Target: 8–12 reps</div>
            </div>

            {sets.map((s,i)=>(
              <SwipeableSet key={i}
                set={s} index={i} activeSet={activeSet}
                onUpdate={(field,val)=>updateSet(i,field,val)}
                onComplete={()=>!s.done&&markSetDone(i)}
                onDelete={i>=MIN_SETS&&!s.done ? ()=>setSets(p=>p.filter((_,j)=>j!==i)) : null}
              />
            ))}

            {/* Add set */}
            <button onClick={addSet} style={{ width:"100%",padding:"12px 0",borderRadius:12,background:"transparent",border:`1.5px dashed ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888888",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginTop:4,transition:"all 0.2s" }}>
              <span style={{ fontSize:18,lineHeight:1 }}>+</span> Add Set
            </button>
          </div>

          {/* ── INSTRUCTIONS ── */}
          <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,marginBottom:16,overflow:"hidden" }}>
            <button onClick={()=>setInstructOpen(o=>!o)} style={{ width:"100%",padding:"16px 18px",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
              <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                <div style={{ display:"flex",alignItems:"center",justifyContent:"center",width:24,height:24 }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></div>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff" }}>How to do this exercise</div>
              </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" style={{ transform:instructOpen?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.25s" }}><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            {instructOpen && (
              <div style={{ padding:"0 18px 18px",animation:"fadeUp 0.25s ease both" }}>
                {instructions.map((step,i)=>(
                  <div key={i} style={{ display:"flex",gap:14,marginBottom:i<instructions.length-1?14:0 }}>
                    <div style={{ width:26,height:26,borderRadius:"50%",background:`${PRIMARY}22`,border:`1.5px solid ${PRIMARY}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:FONT,fontWeight:800,fontSize:12,color:PRIMARY }}>{i+1}</div>
                    <div style={{ fontFamily:FONT,fontSize:14,color:"rgba(255,255,255,0.78)",lineHeight:1.55,paddingTop:3 }}>{step}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── WEIGHT RECOMMENDATION (LOCKED) ── */}
          <div style={{ background:"linear-gradient(135deg,#0f172a,#1e1b4b)",borderRadius:16,border:`1px solid ${PRIMARY}22`,padding:"14px 18px",marginBottom:4,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
            <div style={{ display:"flex",alignItems:"center",gap:12 }}>
              <div style={{ display:"flex",alignItems:"center",justifyContent:"center" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
              <div>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>Recommended Weight</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>Based on your last session</div>
              </div>
            </div>
            <div style={{ background:`${PRIMARY}18`,border:`1px solid ${PRIMARY}33`,borderRadius:20,padding:"6px 14px" }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:PRIMARY }}>Unlock soon</span>
            </div>
          </div>

        </div>
      </div>

      {/* ── STICKY BOTTOM CTA ── */}
      <div style={{ position:"absolute",bottom:0,left:0,right:0,padding:"12px 16px 28px",background:`linear-gradient(180deg,transparent 0%,${BG} 30%)`,paddingTop:20 }}>
        {!allDone ? (
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            {(()=>{
              const ready = started && canComplete(activeSet) && activeSet < sets.length && !sets[activeSet].done;
              const btnBg = !started ? `linear-gradient(135deg,${PRIMARY},#0068CC)`
                : ready ? `linear-gradient(135deg,${PRIMARY},#0068CC)`
                : "linear-gradient(135deg,#1a1a1a,#222)";
              return (
                <button
                  onClick={()=>{ if(!started) setStarted(true); else if(ready) markSetDone(activeSet); }}
                  style={{ width:"100%",padding:"14px 0",borderRadius:50,border:ready||!started?`none`:`1px solid ${BORDER}`,background:btnBg,fontFamily:FONT,fontWeight:800,fontSize:14,color:ready||!started?"#fff":"#444",letterSpacing:1,cursor:ready||!started?"pointer":"not-allowed",display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:ready||!started?`0 4px 28px ${PRIMARY}55`:"none",transition:"all 0.2s" }}>
                  {!started
                    ? <><svg width="13" height="13" viewBox="0 0 13 13" fill="white"><polygon points="0,0 13,6.5 0,13"/></svg> START EXERCISE</>
                    : <>
                        {/* Timer display on the button */}
                        <span style={{ fontFamily:"monospace",fontSize:14,fontWeight:900,color:ready?"#fff":"#555",letterSpacing:2,minWidth:52 }}>
                          {workoutFmt ? workoutFmt(workoutElapsed) : "00:00"}
                        </span>
                        <span style={{ color:ready?"#fff":"#555" }}>·</span>
                        <span>{ready ? `COMPLETE SET ${activeSet+1}` : `LOG WEIGHT & REPS FIRST`}</span>
                      </>
                  }
                </button>
              );
            })()}
            <button onClick={onBack} style={{ width:"100%",padding:"11px 0",borderRadius:50,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888888",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="5 12 19 12"/><polyline points="13 6 19 12 13 18"/></svg>
              Skip this exercise
            </button>
          </div>
        ) : (
          <button onClick={()=>{ if(onComplete) onComplete(); onBack(); }} style={{ width:"100%",padding:"16px 0",borderRadius:50,border:"none",background:"linear-gradient(135deg,#22C55E,#16A34A)",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",boxShadow:"0 4px 24px rgba(34,197,94,0.5)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" style={{display:"inline",marginRight:6,verticalAlign:"middle"}}><polyline points="20 6 9 17 4 12"/></svg>
            EXERCISE COMPLETE — NEXT
          </button>
        )}
      </div>
    </div>
  );
}

// ── Post-workout mood SVG face icons ────────────────────────────────────────
function PostMoodIcon({ type, color }) {
  const s = { width:26, height:26, viewBox:"0 0 24 24", fill:"none", stroke:color||"#888", strokeWidth:"2", strokeLinecap:"round" };
  if (type==="drained") return <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/></svg>;
  if (type==="okay")    return <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3"/><line x1="9" y1="15" x2="15" y2="15"/></svg>;
  if (type==="good")    return <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg>;
  if (type==="pumped")  return <svg {...s}><circle cx="12" cy="12" r="10"/><line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3"/><line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3"/><path d="M8 13s1.5 3 4 3 4-3 4-3"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── NEW INNER PAGE: AI SUMMARY (FULL TABBED) ─────────────────────────────────
function AISummaryPage({ energyKey, onBack }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const { isPremium, setIsPremium } = useUser();
  const aiScrollRef = useScrollPos("ai-summary");
  const [tab, setTab]           = useState("summary");
  const [postMood, setPostMood] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [barWidths, setBarWidths] = useState({});
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [viewed, setViewed]     = useState(false); // track if first view
  const scrollRef               = useRef(null);
  const lvl = ENERGY_LEVELS.find(l => l.key === energyKey) || ENERGY_LEVELS[2];

  // Typewriter for first view
  const AI_FULL = `Great effort today! Based on your mood check-in (${lvl.label.toLowerCase()}), I adapted your session to a moderate-intensity upper body focus — and you crushed it!\n\nYour heart rate stayed in the optimal fat-burning zone for 78% of the session. Recovery time was well-managed between sets, which is smart given your energy levels today.`;
  const [twText, setTwText]   = useState(viewed ? AI_FULL : "");
  const [twDone, setTwDone]   = useState(viewed);

  useEffect(() => {
    if (viewed) return;
    setViewed(true);
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setTwText(AI_FULL.slice(0, i));
      if (i >= AI_FULL.length) { clearInterval(interval); setTwDone(true); }
    }, 18);
    return () => clearInterval(interval);
  }, []);

  // Animate bars when switching tabs
  useEffect(() => {
    setBarWidths({});
    const t = setTimeout(() => setBarWidths({cr:90,intensity:72,active:68,zone:78,mood:88}), 200);
    return () => clearTimeout(t);
  }, [tab]);

  // Collapse header on scroll
  const onScroll = (e) => setHeaderCollapsed(e.target.scrollTop > 60);

  const perf = [
    { key:"cr",        label:"Completion Rate", pct:90, color:"#22C55E", weight:"25%", detail:"10/10 exercises completed",   iconPath:"check"   },
    { key:"intensity", label:"Intensity",        pct:72, color:PRIMARY,   weight:"20%", detail:"Moderate-high effort sustained", iconPath:"bolt"    },
    { key:"active",    label:"Active Time",      pct:68, color:"#F97316", weight:"15%", detail:"306 active cal / 450 total cal", iconPath:"clock"   },
    { key:"zone",      label:"Heart Rate Zone",  pct:78, color:"#EF4444", weight:"—",   detail:"Fat-burn zone · Avg 148 BPM",   iconPath:"heart"   },
    { key:"mood",      label:"Mood Alignment",   pct:88, color:"#8B5CF6", weight:"20%", detail:"Session matched your energy level", iconPath:"smile" },
  ];

  const exercises = [
    { name:"Bench Press",     detail:"3 sets · 12 reps · 60kg", pr:false },
    { name:"Dumbbell Rows",   detail:"3 sets · 10 reps · 22kg", pr:false },
    { name:"Shoulder Press",  detail:"3 sets · 10 reps · 18kg", pr:true  },
    { name:"Tricep Pushdown", detail:"4 sets · 12 reps · 15kg", pr:false },
    { name:"Cable Chest Fly", detail:"3 sets · 12 reps · 20kg", pr:false },
  ];

  const postMoods = [
    { key:"drained", label:"Drained", color:"#EF4444" },
    { key:"okay",    label:"Okay",    color:"#F97316" },
    { key:"good",    label:"Good",    color:"#22C55E" },
    { key:"pumped",  label:"Pumped",  color:PRIMARY   },
  ];

  const cardBg = dark ? "linear-gradient(145deg,#0a0f1e,#141b35)" : "#ffffff";
  const cardBorder = dark ? `1.5px solid ${PRIMARY}33` : `1.5px solid ${PRIMARY}44`;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* ── COLLAPSIBLE HEADER ── */}
      <div style={{ flexShrink:0,background:BG,transition:"all 0.3s ease",overflow:"hidden" }}>
        {/* Always-visible back + title */}
        <div style={{ padding:"50px 18px 0",display:"flex",alignItems:"flex-start",justifyContent:"space-between" }}>
          <button onClick={onBack} style={{ width:38,height:38,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={"#888888"} strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:"#ffffff" }}>UpperBody Strength</div>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>Tuesday, June 10 · 45 min</div>
          </div>
          <div style={{ background:`${PRIMARY}22`,border:`1.5px solid ${PRIMARY}66`,borderRadius:20,padding:"6px 14px" }}>
            <span style={{ fontFamily:FONT,fontWeight:800,fontSize:10,color:PRIMARY,letterSpacing:1 }}>STRENGTH</span>
          </div>
        </div>

        {/* Collapsible stat tiles */}
        <div style={{ maxHeight:headerCollapsed?"0px":"120px",opacity:headerCollapsed?0:1,transition:"max-height 0.35s ease, opacity 0.25s ease",overflow:"hidden",padding:headerCollapsed?"0 16px":"12px 16px 0" }}>
          <div style={{ display:"flex",gap:10 }}>
            {[
              { ico:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.8"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>, val:"382", lbl:"Calories", c:"#EF4444" },
              { ico:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, val:"45",  lbl:"Minutes", c:PRIMARY   },
              { ico:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.8"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>, val:"148", lbl:"Avg BPM", c:"#EF4444" },
            ].map((s,i)=>(
              <div key={i} style={{ flex:1,background:CARD,borderRadius:16,border:`1px solid ${BORDER}`,padding:"12px 8px",textAlign:"center" }}>
                <div style={{ display:"flex",justifyContent:"center",marginBottom:5,color:s.c }}>{s.ico}</div>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#ffffff",lineHeight:1 }}>{s.val}</div>
                <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",marginTop:3 }}>{s.lbl}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Sticky tabs */}
        <div style={{ padding:"12px 16px 0" }}>
          <div style={{ display:"flex",gap:0,background:CARD,borderRadius:12,padding:4,border:`1px solid ${BORDER}` }}>
            {[["summary","AI Summary"],["breakdown","Breakdown"],["exercises","Exercises"]].map(([k,lbl])=>(
              <button key={k} onClick={()=>setTab(k)} style={{ flex:1,padding:"9px 0",borderRadius:10,border:"none",background:tab===k?(dark?"#2a2a2a":"#e8e8e8"):"transparent",fontFamily:FONT,fontWeight:tab===k?700:500,fontSize:12,color:tab===k?"#ffffff":"#888888",cursor:"pointer",transition:"all 0.2s",letterSpacing:0.3 }}>{lbl}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── SCROLL CONTENT ── */}
      <div ref={(el)=>{if(scrollRef)scrollRef.current=el;if(aiScrollRef)aiScrollRef.current=el;}} onScroll={onScroll} style={{ flex:1,overflowY:"auto",padding:"12px 16px 40px" }}>

        {/* ════ TAB: AI SUMMARY ════ */}
        {tab==="summary" && (
          <div style={{ animation:"fadeUp 0.35s ease both" }}>
            {/* Glowing AI card */}
            <div style={{ background:cardBg,borderRadius:22,border:cardBorder,padding:"22px 20px",marginBottom:14,boxShadow:dark?"0 0 40px rgba(109,40,217,0.15)":"0 4px 24px rgba(0,163,255,0.1)" }}>
              <div style={{ display:"flex",gap:14,alignItems:"center",marginBottom:16 }}>
                <div style={{ width:52,height:52,borderRadius:"50%",background:"linear-gradient(135deg,#7C3AED,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 0 24px rgba(124,58,237,0.6)",animation:"glow 3s ease infinite" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </div>
                <div>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#8B5CF6",letterSpacing:2,marginBottom:4 }}>AI POWERED SUMMARY</div>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:dark?"#fff":"#ffffff" }}>VTRXAI Analysis</div>
                </div>
              </div>
              <div style={{ height:1,background:dark?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.06)",marginBottom:16 }}/>

              {/* Typewriter text with glowing cursor */}
              <div style={{ position:"relative" }}>
                <div style={{ fontFamily:FONT,fontSize:14,color:dark?"rgba(255,255,255,0.88)":"#ffffff",lineHeight:1.78,marginBottom:14,whiteSpace:"pre-line" }}>
                  {twText}
                  {!twDone && <span style={{ display:"inline-block",width:2,height:16,background:PRIMARY,marginLeft:2,animation:"blink 0.9s infinite",verticalAlign:"text-bottom",borderRadius:1 }}/>}
                </div>
                {!isPremium && twDone && (
                  <div style={{ position:"absolute",bottom:0,left:0,right:0,height:"68%",background:"linear-gradient(180deg,transparent 0%,rgba(10,10,10,0.95) 35%,rgba(10,10,10,1) 100%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end",paddingBottom:8 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                      <span style={{ fontFamily:FONT,fontSize:12,color:"#fff",fontWeight:700 }}>Full analysis is a Premium feature</span>
                    </div>
                    <button onClick={()=>setIsPremium(true)} style={{ padding:"8px 24px",borderRadius:50,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:12,color:"#fff",cursor:"pointer",boxShadow:`0 4px 16px ${PRIMARY}44` }}>
                      Unlock Premium
                    </button>
                  </div>
                )}
              </div>

              {twDone && (
                <>
                  <div style={{ background:dark?"rgba(255,255,255,0.04)":"rgba(0,0,0,0.04)",border:`1px solid ${dark?"rgba(255,255,255,0.08)":"rgba(0,0,0,0.08)"}`,borderRadius:14,padding:"14px 16px",display:"flex",gap:12,alignItems:"flex-start",marginBottom:16 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EAB308" strokeWidth="2" style={{flexShrink:0,marginTop:1}}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <p style={{ fontFamily:FONT,fontSize:14,color:dark?"rgba(255,255,255,0.75)":"#888888",lineHeight:1.65,margin:0 }}>
                      Tomorrow, I recommend a light active recovery or yoga session to let your muscles rebuild. You've earned it!
                    </p>
                  </div>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                    <span style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Was this helpful?</span>
                    <div style={{ display:"flex",gap:10 }}>
                      {[{v:"down",svg:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3z"/><path d="M17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17"/></svg>},{v:"up",svg:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3z"/><path d="M7 22H4.72A2.31 2.31 0 012 20v-7a2.31 2.31 0 012.72-2H7"/></svg>}].map((t,i)=>(
                        <button key={i} onClick={()=>setFeedback(i)} style={{ background:feedback===i?(dark?"rgba(255,255,255,0.1)":"rgba(0,0,0,0.06)"):"none",border:"none",borderRadius:10,padding:"6px 12px",cursor:"pointer",opacity:feedback!==null&&feedback!==i?0.3:1,display:"flex",alignItems:"center",transition:"all 0.2s" }}>{t.svg}</button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Next session */}
            <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:14 }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:12 }}>NEXT SESSION RECOMMENDATION</div>
              <div style={{ display:"flex",alignItems:"center",gap:14 }}>
                <div style={{ width:48,height:48,borderRadius:14,background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#ffffff",marginBottom:2 }}>Active Recovery</div>
                  <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Tomorrow · 20–30 min · Mobility</div>
                </div>
                <div style={{ background:`${PRIMARY}18`,borderRadius:20,padding:"6px 14px",border:`1px solid ${PRIMARY}44` }}>
                  <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:PRIMARY }}>Schedule</span>
                </div>
              </div>
            </div>

            {/* Post-workout mood */}
            <div style={{ background:dark?"linear-gradient(145deg,#0a0f1e,#141b35)":CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"20px 18px" }}>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:6 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#ffffff" }}>How are you feeling now?</div>
              </div>
              <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",marginBottom:20 }}>Your feedback helps me tailor your next session.</div>
              <div style={{ display:"flex",justifyContent:"space-around" }}>
                {postMoods.map(m=>(
                  <button key={m.key} onClick={()=>setPostMood(m.key)} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:8,background:"none",border:"none",cursor:"pointer" }}>
                    <div style={{ width:56,height:56,borderRadius:"50%",border:`2px solid ${postMood===m.key?m.color:BORDER}`,background:postMood===m.key?`${m.color}22`:"transparent",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s",boxShadow:postMood===m.key?`0 0 16px ${m.color}55`:"none",transform:postMood===m.key?"scale(1.1)":"scale(1)" }}><PostMoodIcon type={m.key} color={m.color}/></div>
                    <span style={{ fontFamily:FONT,fontSize:11,color:postMood===m.key?m.color:"#888888",fontWeight:postMood===m.key?700:500,transition:"all 0.2s" }}>{m.label}</span>
                  </button>
                ))}
              </div>
              {postMood&&<div style={{ marginTop:18,textAlign:"center",animation:"fadeUp 0.3s ease both" }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#22C55E",marginBottom:4 }}>Thanks! We'll adjust tomorrow's plan.</div>
              </div>}
            </div>
          </div>
        )}

        {/* ════ TAB: BREAKDOWN ════ */}
        {tab==="breakdown" && (
          <div style={{ animation:"fadeUp 0.35s ease both" }}>
            <div style={{ background:dark?"linear-gradient(145deg,#0a0f1e,#141b35)":CARD,borderRadius:20,border:cardBorder,padding:"22px 18px",marginBottom:14,textAlign:"center" }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:2,marginBottom:10 }}>OVERALL SESSION SCORE</div>
              <div style={{ position:"relative",width:110,height:110,margin:"0 auto 14px" }}>
                <svg width="110" height="110" style={{ transform:"rotate(-90deg)" }}>
                  <circle cx="55" cy="55" r="46" fill="none" stroke={dark?"#1a1a2e":"#e5e5e5"} strokeWidth="10"/>
                  <circle cx="55" cy="55" r="46" fill="none" stroke={PRIMARY} strokeWidth="10"
                    strokeDasharray={`${2*Math.PI*46}`}
                    strokeDashoffset={`${2*Math.PI*46*(1-83/100)}`}
                    strokeLinecap="round" style={{ transition:"stroke-dashoffset 1.4s ease" }}/>
                </svg>
                <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:28,color:PRIMARY,lineHeight:1 }}>83</div>
                  <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",letterSpacing:1,marginTop:2 }}>/ 100</div>
                </div>
              </div>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#22C55E",marginBottom:4 }}>Excellent</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Top 22% of all your sessions this month</div>
            </div>

            <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14 }}>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:20 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#22C55E"><rect x="1" y="4" width="4" height="17" rx="1"/><rect x="7" y="9" width="4" height="12" rx="1"/><rect x="13" y="6" width="4" height="15" rx="1"/><rect x="19" y="2" width="4" height="19" rx="1"/></svg>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#ffffff" }}>Performance Breakdown</div>
              </div>
              {perf.map((p,i)=>(
                <div key={i} style={{ marginBottom:i<perf.length-1?20:0 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                      <PerfIcon type={p.iconPath} color={p.color}/>
                      <div>
                        <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#ffffff" }}>{p.label}</div>
                        <div style={{ fontFamily:FONT,fontSize:11,color:"#888888",marginTop:1 }}>{p.detail}</div>
                      </div>
                    </div>
                    <div style={{ textAlign:"right",flexShrink:0,marginLeft:10 }}>
                      <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:p.color }}>{p.pct}%</div>
                      {p.weight!=="—"&&<div style={{ fontFamily:FONT,fontSize:10,color:"#888888",marginTop:1 }}>{p.weight}</div>}
                    </div>
                  </div>
                  <div style={{ height:8,background:dark?"#1a1a1a":"#e5e5e5",borderRadius:8,overflow:"hidden" }}>
                    <div style={{ height:"100%",width:`${barWidths[p.key]||0}%`,background:p.color,borderRadius:8,transition:"width 1.1s cubic-bezier(0.4,0,0.2,1)" }}/>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px" }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>VS LAST SESSION</div>
              {[{label:"Calories Burned",val:"+12%"},{label:"Sets Completed",val:"+2"},{label:"Avg Heart Rate",val:"-4 BPM"},{label:"Session Score",val:"+8 pts"}].map((c,i,arr)=>(
                <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:i<arr.length-1?12:0,borderBottom:i<arr.length-1?`1px solid ${BORDER}`:0,marginBottom:i<arr.length-1?12:0 }}>
                  <span style={{ fontFamily:FONT,fontSize:14,color:"#888888" }}>{c.label}</span>
                  <span style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#22C55E" }}>↑ {c.val}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════ TAB: EXERCISES ════ */}
        {tab==="exercises" && (
          <div style={{ animation:"fadeUp 0.35s ease both" }}>
            <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14 }}>
              <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18 }}>
                <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={"#ffffff"} strokeWidth="2"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#ffffff" }}>Exercises Completed</div>
                </div>
                <div style={{ background:"#22C55E22",border:"1px solid #22C55E44",borderRadius:20,padding:"4px 12px" }}>
                  <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#22C55E" }}>5/5</span>
                </div>
              </div>
              {exercises.map((ex,i)=>(
                <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:i<exercises.length-1?16:0,borderBottom:i<exercises.length-1?`1px solid ${BORDER}`:0,marginBottom:i<exercises.length-1?16:0,animation:`fadeUp 0.3s ease ${i*0.07}s both` }}>
                  <div>
                    <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:3 }}>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#ffffff" }}>{ex.name}</div>
                      {ex.pr&&<div style={{ background:"#EAB30822",border:"1px solid #EAB30844",borderRadius:8,padding:"2px 8px" }}><span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#EAB308",letterSpacing:1 }}>PR</span></div>}
                    </div>
                    <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>{ex.detail}</div>
                  </div>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="9 12 11.5 14.5 15.5 9.5"/></svg>
                </div>
              ))}
            </div>

            <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14 }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>TOTAL SESSION VOLUME</div>
              <div style={{ display:"flex",justifyContent:"space-around" }}>
                {[{val:"18",lbl:"Total Sets",c:PRIMARY},{val:"156",lbl:"Total Reps",c:"#22C55E"},{val:"1,890kg",lbl:"Total Load",c:"#F97316"}].map((s,i)=>(
                  <div key={i} style={{ textAlign:"center" }}>
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:s.c,lineHeight:1,marginBottom:4 }}>{s.val}</div>
                    <div style={{ fontFamily:FONT,fontSize:11,color:"#888888" }}>{s.lbl}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px" }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:16 }}>MUSCLES TRAINED</div>
              {[{name:"Chest",pct:85,c:"#EF4444"},{name:"Triceps",pct:75,c:"#F97316"},{name:"Shoulders",pct:60,c:"#EAB308"},{name:"Back",pct:40,c:PRIMARY},{name:"Core",pct:25,c:"#22C55E"}].map((m,i)=>(
                <div key={i} style={{ marginBottom:i<4?14:0 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:6 }}>
                    <span style={{ fontFamily:FONT,fontSize:14,color:"#888888" }}>{m.name}</span>
                    <span style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:m.c }}>{m.pct}%</span>
                  </div>
                  <div style={{ height:8,background:dark?"#1a1a1a":"#e5e5e5",borderRadius:8,overflow:"hidden" }}>
                    <div style={{ height:"100%",width:`${barWidths.cr?m.pct:0}%`,background:m.c,borderRadius:8,transition:`width ${1+i*0.1}s ease` }}/>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ONBOARDING ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function ProgDots({ total, current }) {
  return (
    <div style={{ display:"flex",gap:8,justifyContent:"center" }}>
      {Array.from({length:total}).map((_,i)=>(
        <div key={i} style={{ height:3,width:i===current?28:18,borderRadius:2,background:i===current?PRIMARY:"rgba(255,255,255,0.35)",transition:"all 0.3s" }}/>
      ))}
    </div>
  );
}

function OnboardSlide({ slide, isActive }) {
  const [rdy, setRdy] = useState(false);
  useEffect(() => {
    if (isActive) { const t = setTimeout(() => setRdy(true), 60); return () => clearTimeout(t); }
    else setRdy(false);
  }, [isActive]);
  // Last slide needs room for GET STARTED + Log In + legal text (~195px)
  // Other slides just need room for "Swipe" hint (~70px)
  const bottomPad = slide.cta ? 200 : 70;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: isActive ? 1 : 0, transition: "opacity 0.4s ease", pointerEvents: isActive ? "auto" : "none" }}>
      <img src={slide.bg} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top", transform: isActive ? "scale(1)" : "scale(1.04)", transition: "transform 0.6s ease" }} />
      <div style={{ position: "absolute", inset: 0, background: slide.overlay }} />
      <div style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", padding: "0 28px" }}>
        <div style={{ paddingTop: 66, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, animation: rdy ? "fadeDown 0.5s ease 0.1s both" : "none" }}>
          <VTRXLogo size={50} />
          <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 26, color: PRIMARY, letterSpacing: 4 }}>VTRX</div>
          <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 10, color: "rgba(255,255,255,0.82)", letterSpacing: 3.5 }}>UNLOCK YOUR FULL POTENTIAL</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ paddingBottom: bottomPad }}>
          <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 11, color: PRIMARY, letterSpacing: 3, marginBottom: 14, animation: rdy ? "fadeUp 0.5s ease 0.15s both" : "none" }}>{slide.tag}</div>
          {slide.headline.map((line, i) => (
            <div key={i} style={{ fontFamily: FONT, fontWeight: 800, fontSize: 22, color: "#fff", lineHeight: 1.25, marginBottom: 2, animation: rdy ? `fadeUp 0.5s ease ${0.2 + i * 0.07}s both` : "none" }}>{line}</div>
          ))}
          {slide.body && <p style={{ fontFamily: FONT, fontWeight: 400, fontSize: 13.5, color: "rgba(255,255,255,0.7)", lineHeight: 1.65, margin: "14px 0 0", animation: rdy ? "fadeUp 0.5s ease 0.38s both" : "none" }}>{slide.body}</p>}
          {slide.features && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 18 }}>
              {slide.features.map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, animation: rdy ? `fadeUp 0.5s ease ${0.28 + i * 0.08}s both` : "none" }}>
                  <div style={{ width: 38, height: 38, borderRadius: "50%", background: "rgba(0,163,255,0.18)", border: "1.5px solid rgba(0,163,255,0.4)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><SlideIcon type={f.icon}/></div>
                  <span style={{ fontFamily: FONT, fontSize: 15, fontWeight: 500, color: "rgba(255,255,255,0.92)" }}>{f.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function Chip({ label, selected, onSelect }) {
  return <button onClick={onSelect} style={{ padding:"12px 20px",borderRadius:50,border:selected?`2px solid ${PRIMARY}`:"2px solid rgba(255,255,255,0.9)",background:selected?"rgba(0,163,255,0.2)":"rgba(255,255,255,0.92)",color:selected?PRIMARY:"#111",fontFamily:FONT,fontWeight:600,fontSize:14,cursor:"pointer",whiteSpace:"nowrap",boxShadow:selected?`0 0 14px rgba(0,163,255,0.4)`:"none",transition:"all 0.18s ease" }}>{label}</button>;
}
function ChipGroup({ options, value, onChange, multi }) {
  const toggle=(opt)=>{ if(multi) onChange(value.includes(opt)?value.filter(v=>v!==opt):[...value,opt]); else onChange(opt===value?"":opt); };
  return <div style={{ display:"flex",flexWrap:"wrap",gap:10,marginBottom:4 }}>{options.map(opt=><Chip key={opt} label={opt} selected={multi?value.includes(opt):value===opt} onSelect={()=>toggle(opt)}/>)}</div>;
}
function Q({ n, text, sub }) {
  return <p style={{ fontFamily:FONT,fontWeight:600,fontSize:14,color:"#fff",lineHeight:1.45,margin:"22px 0 11px",textShadow:"0 1px 8px rgba(0,0,0,0.8)" }}>{n}. {text}{sub&&<span style={{ color:"rgba(255,255,255,0.6)",fontWeight:400 }}> {sub}</span>}</p>;
}

function BodyFieldIcon({ type }) {
  const s = { width:16, height:16, viewBox:"0 0 24 24", fill:"none", stroke:"#aaa", strokeWidth:"2" };
  if (type==="scale")  return <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 9v6"/></svg>;
  if (type==="height") return <svg {...s}><line x1="12" y1="2" x2="12" y2="22"/><polyline points="17 7 12 2 7 7"/><polyline points="7 17 12 22 17 17"/></svg>;
  if (type==="age")    return <svg {...s}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
  if (type==="goal")   return <svg {...s}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>;
  if (type==="ruler")  return <svg {...s}><path d="M21 6H3a2 2 0 00-2 2v8a2 2 0 002 2h18a2 2 0 002-2V8a2 2 0 00-2-2z"/><line x1="7" y1="6" x2="7" y2="10"/><line x1="12" y1="6" x2="12" y2="12"/><line x1="17" y1="6" x2="17" y2="10"/></svg>;
  if (type==="muscle") return <svg {...s}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (type==="lock")   return <svg {...s}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>;
  if (type==="percent") return <svg {...s}><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>;
  if (type==="user")    return <svg {...s}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
  if (type==="email")   return <svg {...s}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>;
  if (type==="phone")   return <svg {...s}><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.8a19.79 19.79 0 01-3.07-8.68A2 2 0 012 .14h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="8"/></svg>;
}
function InputField({ placeholder, type, icon, value, onChange, isSelect, options, numeric }) {
  const [focused,setFocused]=useState(false); const [showPw,setShowPw]=useState(false); const isPw=type==="password";
  const style={ position:"relative",background:"rgba(255,255,255,0.92)",borderRadius:50,border:`2px solid ${focused?PRIMARY:"transparent"}`,display:"flex",alignItems:"center",padding:"0 18px",height:54,boxShadow:focused?`0 0 16px rgba(0,163,255,0.3)`:"none",transition:"all 0.2s ease" };
  if(isSelect) return <div style={style}><select value={value} onChange={onChange} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} style={{ flex:1,border:"none",background:"transparent",fontFamily:FONT,fontSize:14,fontWeight:500,color:value?"#111":"#aaa",outline:"none",cursor:"pointer" }}><option value="" disabled>{placeholder}</option>{options.map(o=><option key={o} value={o}>{o}</option>)}</select><span style={{ color:"#aaa",fontSize:14 }}>▾</span></div>;
  return <div style={style}><input type={isPw&&!showPw?"password":"text"} inputMode={numeric?"tel":"text"} placeholder={placeholder} value={value} onChange={onChange} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} style={{ flex:1,border:"none",background:"transparent",fontFamily:FONT,fontSize:14,fontWeight:500,color:"#111",outline:"none" }}/>{icon&&!isPw&&<BodyFieldIcon type={icon}/>}{isPw&&<button onClick={()=>setShowPw(!showPw)} style={{ background:"none",border:"none",cursor:"pointer",padding:4,display:"flex" }}>{showPw?<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>}</button>}</div>;
}
function MeasureField({ label, placeholder, icon, value, onChange, numeric, isHeight }) {
  const [focused, setFocused] = useState(false);

  // Height auto-formatter: insert ' after feet digit
  const handleHeight = (e) => {
    let raw = e.target.value.replace(/[^0-9']/g,"");
    // Auto-insert apostrophe after first digit
    if (raw.length === 1 && /[0-9]/.test(raw) && !value.includes("'")) {
      raw = raw + "'";
    }
    // Prevent more than 1 apostrophe
    const parts = raw.split("'");
    if (parts.length > 2) raw = parts[0] + "'" + parts.slice(1).join("").replace(/'/g,"");
    // Limit inches to 2 digits
    if (parts[1] && parts[1].length > 2) raw = parts[0] + "'" + parts[1].slice(0,2);
    onChange({ target: { value: raw } });
  };

  const inputMode = numeric || isHeight ? "numeric" : "text";
  const inputType = numeric || isHeight ? "text" : "text"; // keep text so we can format height

  return (
    <div>
      {label ? <p style={{ fontFamily:FONT,fontSize:13,fontWeight:600,color:"#fff",marginBottom:6,textShadow:"0 1px 6px rgba(0,0,0,0.8)" }}>{label}</p> : null}
      <div style={{ background:"rgba(255,255,255,0.92)",borderRadius:50,height:52,display:"flex",alignItems:"center",padding:"0 18px",border:`2px solid ${focused?PRIMARY:"transparent"}`,boxShadow:focused?`0 0 14px rgba(0,163,255,0.3)`:"none",transition:"all 0.2s" }}>
        <input
          placeholder={placeholder}
          value={value}
          onChange={isHeight ? handleHeight : onChange}
          onFocus={()=>setFocused(true)}
          onBlur={()=>setFocused(false)}
          inputMode={inputMode}
          pattern={numeric||isHeight?"[0-9']*":undefined}
          style={{ flex:1,border:"none",background:"transparent",fontFamily:FONT,fontSize:14,fontWeight:500,color:"#111",outline:"none" }}
        />
        <BodyFieldIcon type={icon}/>
      </div>
    </div>
  );
}
function NavBar({ title, step, total, onBack, onSkip }) {
  return <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"52px 24px 8px" }}><button onClick={onBack} style={{ background:"none",border:"none",cursor:"pointer",padding:"0 8px 0 0",display:"flex",alignItems:"center" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg></button><div style={{ display:"flex",alignItems:"center",gap:10 }}><span style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:2,textTransform:"uppercase",textShadow:"0 1px 8px rgba(0,0,0,0.8)" }}>{title}</span><span style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:PRIMARY }}>{step}/{total}</span></div><button onClick={onSkip} style={{ background:"none",border:"none",cursor:"pointer",fontFamily:FONT,fontWeight:600,fontSize:13,color:"rgba(255,255,255,0.5)" }}>Skip</button></div>;
}

// ─── Preference screens ───────────────────────────────────────────────────────
function ForgotPasswordPage({ onBack }) {
  const [step, setStep]       = useState("email"); // email → code → done
  const [email, setEmail]     = useState("");
  const [code,  setCode]      = useState("");
  const [newPass, setNewPass] = useState("");
  const [err, setErr]         = useState("");
  const [loading, setLoading] = useState(false);

  const sendCode = async () => {
    if (!email.trim()) { setErr("Please enter your email."); return; }
    setErr(""); setLoading(true);
    try {
      await apiCall("/auth/forgot-password", { method:"POST", body:JSON.stringify({ email:email.trim().toLowerCase() }) });
      setStep("code");
    } catch (e) { setErr(e.message || "Failed to send code."); }
    finally { setLoading(false); }
  };

  const resetPass = async () => {
    if (!code.trim())    { setErr("Enter the verification code."); return; }
    if (newPass.length < 8) { setErr("Password must be at least 8 characters."); return; }
    setErr(""); setLoading(true);
    try {
      await apiCall("/auth/reset-password", { method:"POST", body:JSON.stringify({ email:email.trim().toLowerCase(), code:code.trim(), newPassword:newPass }) });
      setStep("done");
    } catch (e) { setErr(e.message || "Failed to reset password."); }
    finally { setLoading(false); }
  };

  const bg = "https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=800&q=80";
  const overlay = "linear-gradient(180deg,rgba(0,0,0,0.6) 0%,rgba(0,0,0,0.93) 100%)";

  if (step === "done") return (
    <Shell bg={bg} overlay={overlay}>
      <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 28px" }}>
        <div style={{ width:72,height:72,borderRadius:"50%",background:"rgba(34,197,94,0.15)",border:"2px solid #22C55E",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:24 }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:"#fff",textAlign:"center",marginBottom:10 }}>Password Reset!</div>
        <div style={{ fontFamily:FONT,fontSize:14,color:"#888",textAlign:"center",marginBottom:32,lineHeight:1.6 }}>Your password has been updated. You can now log in.</div>
        <button onClick={onBack} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:"pointer",letterSpacing:1 }}>BACK TO LOGIN</button>
      </div>
    </Shell>
  );

  return (
    <Shell bg={bg} overlay={overlay}>
      <div style={{ flex:1,overflowY:"auto",padding:"60px 28px 48px" }}>
        <div style={{ display:"flex",alignItems:"center",gap:14,marginBottom:32 }}>
          <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.1)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#fff" }}>Reset Password</div>
        </div>

        {step === "email" ? (
          <>
            <div style={{ fontFamily:FONT,fontSize:14,color:"#888",marginBottom:24,lineHeight:1.6 }}>Enter your email and we'll send a verification code.</div>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email address" type="email"
              style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"15px 18px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box",marginBottom:16 }}/>
            {err && <div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{err}</div>}
            <button onClick={sendCode} disabled={loading} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:loading?"#555":PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:loading?"not-allowed":"pointer",letterSpacing:1,opacity:loading?0.7:1 }}>
              {loading ? "SENDING..." : "SEND CODE"}
            </button>
          </>
        ) : (
          <>
            <div style={{ fontFamily:FONT,fontSize:14,color:"#888",marginBottom:8,lineHeight:1.6 }}>We sent a code to <span style={{ color:"#fff",fontWeight:600 }}>{email}</span></div>
            <div style={{ fontFamily:FONT,fontSize:13,color:"#666",marginBottom:24 }}>Check your spam folder if you don't see it.</div>
            <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:6 }}>VERIFICATION CODE</div>
            <input value={code} onChange={e=>setCode(e.target.value)} placeholder="6-digit code"
              inputMode="numeric" maxLength={6}
              style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"15px 18px",fontFamily:FONT,fontSize:20,color:"#fff",outline:"none",boxSizing:"border-box",marginBottom:16,letterSpacing:6,textAlign:"center" }}/>
            <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:6 }}>NEW PASSWORD</div>
            <input value={newPass} onChange={e=>setNewPass(e.target.value)} placeholder="Min 8 characters" type="password"
              style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"15px 18px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box",marginBottom:16 }}/>
            {err && <div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{err}</div>}
            <button onClick={resetPass} disabled={loading} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:loading?"#555":PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:loading?"not-allowed":"pointer",letterSpacing:1,opacity:loading?0.7:1 }}>
              {loading ? "RESETTING..." : "RESET PASSWORD"}
            </button>
          </>
        )}
      </div>
    </Shell>
  );
}


function LoginScreen({ onLogin, onSignUp }) {
  const [showForgot, setShowForgot] = useState(false);
  const [email,  setEmail]          = useState("");
  const [pass,   setPass]           = useState("");
  const [showPass, setShowPass]     = useState(false);
  const [err,    setErr]            = useState("");
  const [loading, setLoading]       = useState(false);

  const handle = async () => {
    if (!email.trim()) { setErr("Please enter your email."); return; }
    if (!pass.trim())  { setErr("Please enter your password."); return; }
    setErr(""); setLoading(true);
    try {
      const data = await apiCall("/auth/login", {
        method: "POST",
        body:   JSON.stringify({ email: email.trim().toLowerCase(), password: pass }),
      });
      storeAuth(data.data.token, data.data.user);
      if (data.data.cognitoTokens?.accessToken) {
        localStorage.setItem("vtrx_cognito_token", data.data.cognitoTokens.accessToken);
      }
      onLogin(data.data.user);
    } catch (e) {
      if (e.code === "EMAIL_NOT_CONFIRMED") {
        setErr("Please verify your email before logging in. Check your inbox.");
      } else {
        setErr(e.message || "Login failed. Please check your details.");
      }
    } finally { setLoading(false); }
  };

  if (showForgot) return <ForgotPasswordPage onBack={()=>setShowForgot(false)}/>;
  return (
    <div style={{ position:"absolute",inset:0 }}>
      <img src="https://images.unsplash.com/photo-1517963879433-6ad2b056d712?w=800&q=80" alt="" style={{ position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover" }}/>
      <div style={{ position:"absolute",inset:0,background:"linear-gradient(180deg,rgba(0,0,0,0.45) 0%,rgba(0,0,0,0.92) 100%)" }}/>
      <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",padding:"60px 28px 48px",overflowY:"auto" }}>
        <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:0 }}>
          <VTRXLogo size={52}/>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:30,color:"#fff",marginTop:20,marginBottom:4,letterSpacing:-0.5 }}>Welcome back</div>
          <div style={{ fontFamily:FONT,fontSize:14,color:"#888",marginBottom:36 }}>Sign in to your account</div>
          {/* Email */}
          <div style={{ width:"100%",marginBottom:14 }}>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email address"
              type="email" autoCapitalize="none" autoCorrect="off"
              style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"15px 18px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
          </div>
          {/* Password */}
          <div style={{ width:"100%",position:"relative",marginBottom:8 }}>
            <input value={pass} onChange={e=>setPass(e.target.value)} placeholder="Password"
              type={showPass?"text":"password"}
              onKeyDown={e=>e.key==="Enter"&&handle()}
              style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"15px 52px 15px 18px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
            <button onClick={()=>setShowPass(p=>!p)} style={{ position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",padding:4 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2">
                {showPass ? <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></> : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}
              </svg>
            </button>
          </div>
          {err && <div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:8,textAlign:"center",width:"100%" }}>{err}</div>}
          <button onClick={()=>setShowForgot(true)} style={{ background:"none",border:"none",fontFamily:FONT,fontSize:13,color:"#888",cursor:"pointer",alignSelf:"flex-end",marginBottom:24,padding:0 }}>Forgot password?</button>
          <button onClick={handle} disabled={loading}
            style={{ width:"100%",padding:"16px 0",borderRadius:50,background:loading?"#555":PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:loading?"not-allowed":"pointer",letterSpacing:1,marginBottom:16,opacity:loading?0.7:1,transition:"all 0.2s" }}>
            {loading ? "SIGNING IN..." : "SIGN IN"}
          </button>
          <div style={{ fontFamily:FONT,fontSize:14,color:"#888" }}>
            Don't have an account?{" "}
            <button onClick={onSignUp} style={{ background:"none",border:"none",fontFamily:FONT,fontSize:14,color:PRIMARY,cursor:"pointer",fontWeight:700,padding:0 }}>Sign up</button>
          </div>
        </div>
      </div>
    </div>
  );
}


function SignUpScreen({ onContinue, onBack }) {
  const [f, setF]         = useState({ name:"", username:"", email:"", password:"", confirm:"" });
  const [err, setErr]     = useState("");
  const [loading, setLoading] = useState(false);
  const s = k => e => setF({ ...f, [k]: e.target.value });

  const handle = async () => {
    if (!f.name.trim())     { setErr("Please enter your name.");           return; }
    if (!f.username.trim()) { setErr("Please choose a username.");         return; }
    if (!f.email.trim())    { setErr("Please enter your email.");          return; }
    if (f.password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (f.password !== f.confirm) { setErr("Passwords do not match.");     return; }
    setErr(""); setLoading(true);
    try {
      await apiCall("/auth/signup", {
        method: "POST",
        body:   JSON.stringify({
          name:     f.name.trim(),
          username: f.username.trim().toLowerCase(),
          email:    f.email.trim().toLowerCase(),
          password: f.password,
        }),
      });
      // Store email for verification step
      if (typeof localStorage !== "undefined") localStorage.setItem("vtrx_pending_email", f.email.trim().toLowerCase());
      onContinue();
    } catch (e) {
      setErr(e.message || "Signup failed. Please try again.");
    } finally { setLoading(false); }
  };

  const fields = [
    { key:"name",     label:"FULL NAME",    placeholder:"Your name",       type:"text"     },
    { key:"username", label:"USERNAME",     placeholder:"@username",       type:"text"     },
    { key:"email",    label:"EMAIL",        placeholder:"Email address",   type:"email"    },
    { key:"password", label:"PASSWORD",     placeholder:"Min 8 characters",type:"password" },
    { key:"confirm",  label:"CONFIRM PASSWORD", placeholder:"Repeat password", type:"password" },
  ];

  return (
    <Shell bg="https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.92) 100%)">
      <div style={{ flex:1,overflowY:"auto",padding:"60px 24px 40px" }}>
        <div style={{ display:"flex",alignItems:"center",gap:14,marginBottom:28 }}>
          <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.1)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#fff" }}>Create Account</div>
            <div style={{ fontFamily:FONT,fontSize:13,color:"#888",marginTop:2 }}>Step 1 of 6</div>
          </div>
        </div>

        {fields.map(({key,label,placeholder,type}) => (
          <div key={key} style={{ marginBottom:16 }}>
            <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:6 }}>{label}</div>
            <input value={f[key]} onChange={s(key)} placeholder={placeholder} type={type}
              autoCapitalize="none" autoCorrect="off"
              style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"14px 16px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
          </div>
        ))}

        {err && <div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{err}</div>}

        <button onClick={handle} disabled={loading}
          style={{ width:"100%",padding:"16px 0",borderRadius:50,background:loading?"#555":PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:loading?"not-allowed":"pointer",letterSpacing:1,marginTop:8,opacity:loading?0.7:1 }}>
          {loading ? "CREATING ACCOUNT..." : "CONTINUE"}
        </button>
        <div style={{ fontFamily:FONT,fontSize:11,color:"#555",textAlign:"center",marginTop:16,lineHeight:1.6 }}>
          By continuing you agree to VTRX Terms of Service and Privacy Policy.
        </div>
      </div>
    </Shell>
  );
}


function EmailVerificationScreen({ onContinue, onBack }) {
  const [code, setCode]         = useState("");
  const [email, setEmail]       = useState("");
  const [err, setErr]           = useState("");
  const [loading, setLoading]   = useState(false);
  const [resending, setResend]  = useState(false);
  const [resent, setResent]     = useState(false);

  useEffect(() => {
    // Get the email that was signed up with
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("vtrx_pending_email") : "";
    if (stored) setEmail(stored);
  }, []);

  const verify = async () => {
    if (code.length !== 6) { setErr("Please enter the 6-digit code."); return; }
    setErr(""); setLoading(true);
    try {
      await apiCall("/auth/confirm-email", { method:"POST", body:JSON.stringify({ email, code:code.trim() }) });
      onContinue();
    } catch (e) {
      setErr(e.message || "Invalid code. Please try again.");
    } finally { setLoading(false); }
  };

  const resend = async () => {
    setResend(true);
    try {
      await apiCall("/auth/forgot-password", { method:"POST", body:JSON.stringify({ email }) });
      setResent(true);
      setTimeout(() => setResent(false), 4000);
    } catch {}
    finally { setResend(false); }
  };

  return (
    <Shell bg="https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.92) 100%)">
      <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 28px 48px" }}>
        <div style={{ width:72,height:72,borderRadius:"50%",background:"rgba(0,163,255,0.15)",border:"2px solid rgba(0,163,255,0.4)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:28 }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        </div>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:"#fff",textAlign:"center",marginBottom:10 }}>Check your email</div>
        <div style={{ fontFamily:FONT,fontSize:14,color:"#888",textAlign:"center",marginBottom:6,lineHeight:1.6 }}>We sent a 6-digit code to</div>
        <div style={{ fontFamily:FONT,fontSize:15,color:"#fff",fontWeight:700,textAlign:"center",marginBottom:32 }}>{email}</div>

        <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}
          placeholder="000000" inputMode="numeric" maxLength={6}
          style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:`2px solid ${code.length===6?PRIMARY:"rgba(255,255,255,0.2)"}`,borderRadius:16,padding:"16px 0",fontFamily:FONT,fontSize:32,fontWeight:900,color:"#fff",outline:"none",boxSizing:"border-box",marginBottom:16,letterSpacing:12,textAlign:"center",transition:"border-color 0.2s" }}/>

        {err && <div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{err}</div>}

        <button onClick={verify} disabled={loading||code.length!==6}
          style={{ width:"100%",padding:"16px 0",borderRadius:50,background:code.length===6?PRIMARY:"#333",border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:code.length===6?"pointer":"not-allowed",letterSpacing:1,marginBottom:16,transition:"all 0.2s",opacity:loading?0.7:1 }}>
          {loading ? "VERIFYING..." : "VERIFY EMAIL"}
        </button>

        <div style={{ display:"flex",gap:6,alignItems:"center" }}>
          <span style={{ fontFamily:FONT,fontSize:13,color:"#888" }}>Didn't receive it?</span>
          <button onClick={resend} disabled={resending}
            style={{ background:"none",border:"none",fontFamily:FONT,fontSize:13,color:resent?"#22C55E":PRIMARY,cursor:"pointer",fontWeight:700,padding:0 }}>
            {resent ? "Sent!" : resending ? "Sending..." : "Resend code"}
          </button>
        </div>
        <div style={{ fontFamily:FONT,fontSize:12,color:"#555",textAlign:"center",marginTop:16,lineHeight:1.5 }}>
          Check your spam folder if you don't see it.
        </div>
      </div>
    </Shell>
  );
}

function BodyScreen({ onContinue, onBack }) {
  const { user, setUser } = useUser();
  const [weight, setWeight] = useState(user.weight || "");
  const [height, setHeight] = useState(user.height || "");
  const [age, setAge]       = useState(user.age    || "");
  const [gender, setGender] = useState(user.gender || "");

  const GENDERS = ["Male","Female","Other","Prefer not to say"];

  const handleContinue = () => {
    setUser(u=>({...u, weight, height, age, gender}));
    onContinue();
  };

  return (
    <Shell bg="https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=800&q=80"
           overlay="linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.85) 100%)">
      <NavBar title="Body Measurements" step={1} total={6} onBack={onBack} onSkip={onContinue}/>
      <div style={{ flex:1,overflowY:"auto",padding:"0 24px 40px" }}>

        <div style={{ marginBottom:24 }}>
          <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:8 }}>BODYWEIGHT (lbs)</div>
          <input value={weight} onChange={e=>setWeight(e.target.value)} placeholder="e.g. 165"
            inputMode="decimal" style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"14px 16px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
        </div>

        <div style={{ marginBottom:24 }}>
          <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:8 }}>HEIGHT (ft/in)</div>
          <input value={height} onChange={e=>setHeight(e.target.value)} placeholder="e.g. 5'10"
            style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"14px 16px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
        </div>

        <div style={{ marginBottom:24 }}>
          <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:8 }}>AGE</div>
          <input value={age} onChange={e=>setAge(e.target.value)} placeholder="e.g. 28"
            inputMode="numeric" style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"14px 16px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
        </div>

        <div style={{ marginBottom:32 }}>
          <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:12 }}>GENDER</div>
          <div style={{ display:"flex",flexWrap:"wrap",gap:10 }}>
            {GENDERS.map(g=>(
              <button key={g} onClick={()=>setGender(g)}
                style={{ padding:"10px 20px",borderRadius:50,border:`1.5px solid ${gender===g?PRIMARY:"rgba(255,255,255,0.2)"}`,background:gender===g?PRIMARY:"transparent",fontFamily:FONT,fontWeight:600,fontSize:13,color:"#fff",cursor:"pointer",transition:"all 0.2s" }}>
                {g}
              </button>
            ))}
          </div>
        </div>

        <CTA label="CONTINUE" onClick={handleContinue}/>
        <div style={{ textAlign:"center",marginTop:14,fontFamily:FONT,fontSize:11,color:"#555" }}>
          You can add more body stats in your profile later
        </div>
      </div>
    </Shell>
  );
}


function WorkoutTypeIcon({ type }) {
  const s = { width:18, height:18, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:"2" };
  if (type==="barbell"||type==="muscle") return <svg {...s}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (type==="heart"||type==="cardio")   return <svg {...s}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>;
  if (type==="rest"||type==="recovery")  return <svg {...s}><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>;
  if (type==="run"||type==="hiit")       return <svg {...s}><circle cx="13" cy="4" r="2"/><path d="M10.5 20.5l1-4-2.5-2.5L11 9l4 3h4"/><path d="M7 20.5l2.5-6"/></svg>;
  if (type==="strength")                 return <svg {...s}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function WorkoutScreen({ onContinue, onBack }) {
  const[goal,setGoal]=useState("");const[level,setLevel]=useState("");const[style,setStyle]=useState([]);const[days,setDays]=useState("");const[time,setTime]=useState("");const[location,setLocation]=useState("");const[equip,setEquip]=useState([]);
  return <Shell bg="https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.55) 30%,rgba(0,0,0,0.85) 100%)"><NavBar title="Customize Workout" step={2} total={4} onBack={onBack} onSkip={onContinue}/><div style={{ flex:1,overflowY:"auto",padding:"0 24px 24px" }}><Q n="1" text="What is your primary goal?" sub="(Select one)"/><ChipGroup options={["Build Muscle","Lose Weight","Stay Active","Improve Endurance","Get Toned"]} value={goal} onChange={setGoal}/><Q n="2" text="What is your experience level?" sub="(Select one)"/><ChipGroup options={["Beginner","Intermediate","Advanced","Professional"]} value={level} onChange={setLevel}/><Q n="3" text="What is your preferred workout style?" sub="(Pick 1–3)"/><ChipGroup options={["Strength Training","Cardio","HIIT","Bodyweight","Functional Fitness"]} value={style} onChange={setStyle} multi/><Q n="4" text="How many times do you want to work out each week?"/><ChipGroup options={["1–2 Days/Week","3–4 Days/Week","5+ Days/Week"]} value={days} onChange={setDays}/><Q n="5" text="Where do you usually work out?" sub="(Select one)"/><ChipGroup options={["Full Gym","Home","Outdoors","Mix of both"]} value={location} onChange={setLocation}/><Q n="6" text="What equipment do you have access to?" sub="(Select all that apply)"/><ChipGroup options={["Dumbbells","Barbell & Plates","Pull-up Bar","Resistance Bands","Kettlebells","Bench","Cable Machine","No Equipment"]} value={equip} onChange={setEquip} multi/><Q n="7" text="How much time can you dedicate to fitness daily?"/><ChipGroup options={["15–30 minutes","30–45 minutes","45–60 minutes","60+ minutes"]} value={time} onChange={setTime}/><div style={{marginTop:28}}><CTA label="CONTINUE" onClick={onContinue}/></div></div></Shell>;
}
function NutritionScreen({ onContinue, onBack }) {
  const[want,setWant]=useState("");const[nutGoal,setNutGoal]=useState("");const[track,setTrack]=useState("");const[diet,setDiet]=useState([]);const[meals,setMeals]=useState("");
  return <Shell bg="https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,10,20,0.45) 0%,rgba(0,10,20,0.55) 30%,rgba(0,10,20,0.9) 100%)"><NavBar title="Customize Nutrition" step={3} total={4} onBack={onBack} onSkip={onContinue}/><div style={{ flex:1,overflowY:"auto",padding:"0 24px 24px" }}><Q n="1" text="Would you like meal suggestions based on your goals?"/><ChipGroup options={["Yes","No"]} value={want} onChange={setWant}/><Q n="2" text="What's your main nutrition goal?"/><ChipGroup options={["Lose Fat","Build Muscle","Maintain","Eat clean","Improve Energy"]} value={nutGoal} onChange={setNutGoal}/><Q n="3" text="Do you track your calories or macros?"/><ChipGroup options={["Yes, both","Only Calories","No, but I'd like to","No, not interested"]} value={track} onChange={setTrack}/><Q n="4" text="Do you have any dietary preferences or restrictions?"/><ChipGroup options={["Vegan","Vegetarian","Gluten Free","Dairy-Free","No Peanuts","Other?"]} value={diet} onChange={setDiet} multi/><Q n="5" text="How many meals do you eat daily?"/><ChipGroup options={["2 meals","3 meals","4+ meals","It varies"]} value={meals} onChange={setMeals}/><div style={{marginTop:28}}><CTA label="CONTINUE" onClick={onContinue}/></div></div></Shell>;
}
function ChallengeScreen({ onContinue, onBack }) {
  return (
    <Shell bg="https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=800&q=80"
           overlay="linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.85) 100%)">
      <NavBar title="Challenges" step={4} total={6} onBack={onBack} onSkip={onContinue}/>
      <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px 40px" }}>
        <div style={{ width:80,height:80,borderRadius:24,background:"rgba(165,85,247,0.15)",border:"1.5px solid rgba(165,85,247,0.4)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:28 }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#A855F7" strokeWidth="1.8"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0012 0V2z"/></svg>
        </div>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:"#fff",textAlign:"center",marginBottom:12 }}>
          Challenges
        </div>
        <div style={{ fontFamily:FONT,fontSize:14,color:"#888",textAlign:"center",lineHeight:1.7,marginBottom:12 }}>
          Compete, earn rewards and build habits through stake-based fitness challenges.
        </div>
        <div style={{ background:"rgba(165,85,247,0.12)",border:"1px solid rgba(165,85,247,0.3)",borderRadius:20,padding:"10px 24px",marginBottom:36 }}>
          <span style={{ fontFamily:FONT,fontWeight:800,fontSize:12,color:"#A855F7",letterSpacing:1 }}>COMING SOON</span>
        </div>
        <div style={{ width:"100%" }}>
          <CTA label="CONTINUE" onClick={onContinue}/>
        </div>
      </div>
    </Shell>
  );
}


function PricingScreen({ onContinue, onBack }) {
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeErr,     setStripeErr]     = useState("");

  const subscribe = async (plan) => {
    setStripeLoading(true); setStripeErr("");
    try {
      const data = await apiCall("/payments/create-checkout", {
        method: "POST",
        body:   JSON.stringify({ plan }),
      });
      // Redirect to Stripe checkout — user pays, Stripe redirects back
      if (data.data?.url) {
        window.location.href = data.data.url;
      }
    } catch (e) {
      setStripeErr(e.message || "Payment setup failed. Try again.");
      setStripeLoading(false);
    }
  };
  const { setIsPremium } = useUser();
  const [selected, setSelected] = useState("free");
  const [billingAnnual, setBillingAnnual] = useState(true);

  const FREE_FEATURES = [
    "1 training programme — 5 days, fully personalised",
    "Unlimited workout logging",
    "14-day workout history",
    "1 basic AI weekly summary",
    "Daily mood check-in",
    "Browse all recipes (view only)",
    "Save up to 3 recipes",
    "Meal swap — twice per day",
    "Water intake tracker",
    "Streak tracking",
    "3 personal records tracked",
    "Basic weekly stats",
  ];

  const PREMIUM_FEATURES = [
    "Everything in your 1-month free trial",
    "Unlimited programmes + full customisation",
    "Full workout history — all time",
    "AI coaching summary after every workout",
    "Weekly AI performance report every Sunday",
    "AI-generated personalised workout plan",
    "Mood-based AI training recommendations",
    "Full recipe instructions & macros",
    "Unlimited saved recipes",
    "Weekly meal plan + auto grocery list",
    "Unlimited meal swaps",
    "Unlimited personal records",
    "Full progress charts & trends",
    "Progress photos & body measurements",
    "Challenges access — coming soon",
  ];

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",overflowY:"auto" }}>
      {/* Header */}
      <div style={{ padding:"52px 20px 0",flexShrink:0 }}>
        <button onClick={onBack} style={{ background:"none",border:"none",cursor:"pointer",padding:0,marginBottom:16 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#fff",marginBottom:6 }}>Keep What You Had</div>
        <div style={{ fontFamily:FONT,fontSize:13,color:"#888",marginBottom:24 }}>1 month free. Then $9.99/month or $69.99/year. Cancel anytime.</div>

        {/* Billing toggle */}
        <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:24 }}>
          <span style={{ fontFamily:FONT,fontSize:12,color:billingAnnual?"#888":"#fff",fontWeight:600 }}>Monthly</span>
          <div onClick={()=>setBillingAnnual(a=>!a)}
            style={{ width:46,height:26,borderRadius:50,background:PRIMARY,cursor:"pointer",position:"relative",transition:"all 0.2s" }}>
            <div style={{ position:"absolute",top:3,left:billingAnnual?22:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s" }}/>
          </div>
          <span style={{ fontFamily:FONT,fontSize:12,color:billingAnnual?"#fff":"#888",fontWeight:600 }}>
            Annual <span style={{ color:"#22C55E",fontSize:10,fontWeight:700 }}>SAVE 40%</span>
          </span>
        </div>
      </div>

      <div style={{ padding:"0 16px 40px",display:"flex",flexDirection:"column",gap:14 }}>

        {/* FREE CARD */}
        <div onClick={()=>setSelected("free")}
          style={{ borderRadius:20,border:`2px solid ${selected==="free"?PRIMARY:BORDER}`,background:selected==="free"?"rgba(0,163,255,0.06)":CARD,padding:"20px",cursor:"pointer",transition:"all 0.2s" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
            <div>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff" }}>Free</div>
                <div style={{ background:"rgba(255,255,255,0.1)",borderRadius:50,padding:"2px 10px",fontFamily:FONT,fontSize:10,fontWeight:700,color:"#888",letterSpacing:1 }}>FOREVER</div>
              </div>
              <div style={{ fontFamily:FONT,fontSize:26,fontWeight:900,color:"#fff" }}>$0<span style={{ fontSize:13,fontWeight:500,color:"#888" }}>/month</span></div>
            </div>
            <div style={{ width:22,height:22,borderRadius:"50%",border:`2px solid ${selected==="free"?PRIMARY:"#444"}`,background:selected==="free"?PRIMARY:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:4 }}>
              {selected==="free" && <div style={{ width:8,height:8,borderRadius:"50%",background:"#fff" }}/>}
            </div>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {FREE_FEATURES.map((f,i)=>(
              <div key={i} style={{ display:"flex",alignItems:"center",gap:10 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span style={{ fontFamily:FONT,fontSize:13,color:"#aaa" }}>{f}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Free trial callout */}
        <div style={{ background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.25)",borderRadius:14,padding:"12px 16px",display:"flex",alignItems:"center",gap:12,marginBottom:4 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:"#22C55E" }}>1 Month Free Trial — No Card Needed</div>
            <div style={{ fontFamily:FONT,fontSize:11,color:"#888",marginTop:1 }}>Unlimited AI coaching, meal planning, full history — every feature unlocked.</div>
          </div>
        </div>

        {/* PREMIUM CARD */}
        <div onClick={()=>setSelected("premium")}
          style={{ borderRadius:20,border:`2px solid ${selected==="premium"?PRIMARY:BORDER}`,background:selected==="premium"?"rgba(0,163,255,0.08)":CARD,padding:"20px",cursor:"pointer",transition:"all 0.2s",position:"relative",overflow:"hidden" }}>

          {/* Most Popular badge */}
          <div style={{ position:"absolute",top:0,right:0,background:PRIMARY,padding:"5px 14px",borderRadius:"0 18px 0 12px",fontFamily:FONT,fontSize:10,fontWeight:800,color:"#fff",letterSpacing:1 }}>MOST POPULAR</div>

          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,marginTop:4 }}>
            <div>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff" }}>Premium</div>
                <div style={{ background:`rgba(0,163,255,0.15)`,borderRadius:50,padding:"2px 10px",fontFamily:FONT,fontSize:10,fontWeight:700,color:PRIMARY,letterSpacing:1 }}>PRO</div>
              </div>
              {billingAnnual
                ? <div>
                    <div style={{ fontFamily:FONT,fontSize:26,fontWeight:900,color:"#fff" }}>$5.83<span style={{ fontSize:13,fontWeight:500,color:"#888" }}>/month</span></div>
                    <div style={{ fontFamily:FONT,fontSize:11,color:"#22C55E",fontWeight:600,marginTop:2 }}>$69.99 billed annually · Save 40%</div>
                  </div>
                : <div style={{ fontFamily:FONT,fontSize:26,fontWeight:900,color:"#fff" }}>$9.83<span style={{ fontSize:13,fontWeight:500,color:"#888" }}>/month</span></div>
              }
            </div>
            <div style={{ width:22,height:22,borderRadius:"50%",border:`2px solid ${selected==="premium"?PRIMARY:"#444"}`,background:selected==="premium"?PRIMARY:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:8 }}>
              {selected==="premium" && <div style={{ width:8,height:8,borderRadius:"50%",background:"#fff" }}/>}
            </div>
          </div>

          {/* Everything in free + */}
          <div style={{ background:"rgba(0,163,255,0.08)",borderRadius:10,padding:"8px 12px",marginBottom:12,display:"flex",alignItems:"center",gap:8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
            <span style={{ fontFamily:FONT,fontSize:12,color:PRIMARY,fontWeight:700 }}>Everything in Free, plus:</span>
          </div>

          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {PREMIUM_FEATURES.map((f,i)=>(
              <div key={i} style={{ display:"flex",alignItems:"center",gap:10 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span style={{ fontFamily:FONT,fontSize:13,color:"#ccc" }}>{f}</span>
              </div>
            ))}
          </div>

          {/* 7-day trial note */}
          <div style={{ marginTop:14,padding:"10px 12px",background:"rgba(34,197,94,0.08)",borderRadius:10,border:"1px solid rgba(34,197,94,0.2)" }}>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#22C55E",fontWeight:700,textAlign:"center" }}>1 month free trial — cancel anytime</div>
          </div>
        </div>

        {/* CTA Button */}
        <button onClick={()=>{ if(selected==="premium") setIsPremium(true); onContinue(); }}
          style={{ width:"100%",padding:"16px 0",borderRadius:50,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:"pointer",boxShadow:`0 4px 24px ${PRIMARY}44`,marginTop:4,letterSpacing:0.5 }}>
          {selected==="free" ? "Continue with Free" : "Start Free — 1 Month On Us"}
        </button>

        {selected==="premium" && (
          <div style={{ textAlign:"center",fontFamily:FONT,fontSize:11,color:"#555",marginTop:-8 }}>
            No credit card required · Cancel anytime
          </div>
        )}

        <button onClick={()=>setSelected(selected==="free"?"premium":"free")}
          style={{ background:"none",border:"none",fontFamily:FONT,fontSize:12,color:"#555",cursor:"pointer",textDecoration:"underline",textAlign:"center" }}>
          {selected==="free" ? "See what Premium includes" : "Continue with Free instead"}
        </button>
      </div>
    </div>
  );
}

function ReadyScreen({ onFinish }) {
  const[v,setV]=useState(false);useEffect(()=>{const t=setTimeout(()=>setV(true),100);return()=>clearTimeout(t);},[]);
  return <Shell bg="https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.6) 40%,rgba(0,0,0,0.94) 100%)"><div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px",textAlign:"center" }}><div style={{ width:100,height:100,borderRadius:"50%",background:"rgba(0,163,255,0.15)",border:`2.5px solid ${PRIMARY}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 28px",boxShadow:`0 0 50px rgba(0,163,255,0.4)`,opacity:v?1:0,transform:v?"scale(1)":"scale(0.6)",transition:"all 0.5s cubic-bezier(0.34,1.56,0.64,1)" }}><VTRXLogo size={44}/></div><div style={{ opacity:v?1:0,transform:v?"translateY(0)":"translateY(20px)",transition:"all 0.5s ease 0.25s" }}><div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:"#fff",marginBottom:10,lineHeight:1.2 }}>Your Profile is Ready!</div><div style={{ fontFamily:FONT,fontSize:14,color:"rgba(255,255,255,0.65)",lineHeight:1.65,marginBottom:32 }}>VTRX has built your personalised training plan, meal of the day, and first workout — all based on your answers.</div></div><div style={{ width:"100%",background:"rgba(0,163,255,0.12)",border:"1.5px solid rgba(0,163,255,0.4)",borderRadius:20,padding:"20px 22px",marginBottom:28,opacity:v?1:0,transform:v?"translateY(0)":"translateY(20px)",transition:"all 0.5s ease 0.4s" }}><p style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:PRIMARY,letterSpacing:2,marginBottom:14 }}>YOUR FIRST WORKOUT IS READY</p><div style={{ display:"flex",alignItems:"center",gap:14 }}><div style={{ width:52,height:52,borderRadius:12,background:"rgba(0,163,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center" }}><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="2"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg></div><div style={{textAlign:"left"}}><p style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",margin:"0 0 3px" }}>Beginner Full Body</p><p style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.6)",margin:0 }}>25 min · Home · Strength</p></div></div></div><div style={{ width:"100%",opacity:v?1:0,transition:"opacity 0.5s ease 0.55s" }}><CTA label="LET'S GO" onClick={onFinish}/></div><p style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.4)",marginTop:16 }}>Day 1 streak starts now</p></div></Shell>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MOOD SHEET ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function MoodSheet({ visible, onSelect }) {
  const[step,setStep]=useState(0);const[picked,setPicked]=useState(null);
  const choose=(key)=>{setPicked(key);setStep(1);};
  const lvl=picked?ENERGY_LEVELS.find(l=>l.key===picked):null;
  const w=picked?WORKOUTS[picked]:null;
  const hr=new Date().getHours();const greet=hr<12?"morning":hr<17?"afternoon":"evening";
  return (
    <>
      <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.82)",backdropFilter:"blur(8px)",zIndex:200,opacity:visible?1:0,transition:"opacity 0.4s ease",pointerEvents:visible?"auto":"none" }}/>
      <div style={{ position:"fixed",bottom:0,left:"50%",transform:visible?"translate(-50%,0)":"translate(-50%,100%)",width:"100%",maxWidth:430,background:"linear-gradient(180deg,#131313 0%,#0d0d0d 100%)",borderRadius:"26px 26px 0 0",border:`1px solid ${BORDER}`,borderBottom:"none",zIndex:201,transition:"transform 0.45s cubic-bezier(0.34,1.2,0.64,1)",paddingBottom:36,boxShadow:"0 -30px 80px rgba(0,0,0,0.9)" }}>
        <div style={{ display:"flex",justifyContent:"center",padding:"14px 0 6px" }}><div style={{ width:40,height:4,borderRadius:2,background:"#2a2a2a" }}/></div>
        {step===0?(
          <div style={{ padding:"6px 22px 0" }}>
            <div style={{ textAlign:"center",marginBottom:22 }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:21,color:"#fff",marginBottom:6 }}>Good {greet}</div>
              <div style={{ fontFamily:FONT,fontWeight:500,fontSize:13,color:"#888888",lineHeight:1.55 }}>How are you feeling today?<br/><span style={{ fontSize:12,color:"#3a3a3a" }}>Your answer adjusts your workout and meal plan</span></div>
            </div>
            <div style={{ display:"flex",flexDirection:"column",gap:9 }}>
              {ENERGY_LEVELS.map((lvl,i)=>(
                <button key={lvl.key} onClick={()=>choose(lvl.key)} style={{ display:"flex",alignItems:"center",gap:14,padding:"13px 16px",borderRadius:16,background:CARD,border:`1.5px solid ${BORDER}`,cursor:"pointer",textAlign:"left",animation:`fadeUp 0.3s ease ${i*0.05}s both`,transition:"border-color 0.2s,background 0.2s" }}>
                  <div style={{ flexShrink:0,width:38,display:"flex",alignItems:"center",justifyContent:"center" }}><EnergyFaceIcon type={lvl.faceType} color={lvl.color} size={28}/></div>
                  <div style={{ flex:1 }}><div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",marginBottom:1 }}>{lvl.label}</div><div style={{ fontFamily:FONT,fontSize:12,color:"#444" }}>{lvl.sub}</div></div>
                  <div style={{ width:26,height:26,borderRadius:"50%",background:lvl.bg,border:`1px solid ${lvl.color}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><svg width="9" height="9" viewBox="0 0 10 10" fill={lvl.color}><polygon points="0,0 10,5 0,10"/></svg></div>
                </button>
              ))}
            </div>
            <p style={{ fontFamily:FONT,fontSize:11,color:"#2e2e2e",textAlign:"center",marginTop:16,lineHeight:1.6 }}>Your streak is protected regardless of your energy level today</p>
          </div>
        ):lvl&&w?(
          <div style={{ padding:"6px 22px 0",animation:"fadeUp 0.3s ease both" }}>
            <div style={{ textAlign:"center",marginBottom:20 }}>
              <div style={{ width:60,height:60,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 10px" }}><EnergyFaceIcon type={lvl.faceType} size={52}/></div>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",marginBottom:4 }}>{lvl.label}</div>
              <div style={{ fontFamily:FONT,fontSize:13,color:"#444" }}>Here's what VTRX has lined up for you</div>
            </div>
            <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:14 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
                <div><div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:lvl.color,letterSpacing:2,marginBottom:4 }}>TODAY'S WORKOUT</div><div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff" }}>{w.name}</div></div>
                <div style={{ background:lvl.bg,border:`1px solid ${lvl.color}55`,borderRadius:20,padding:"4px 12px" }}><span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:lvl.color,letterSpacing:1 }}>{w.type}</span></div>
              </div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#444",marginBottom:14 }}>Target: {w.target}</div>
              <div style={{ display:"flex",gap:24 }}>
                {[{val:w.mins,lbl:"MIN",col:"#EF4444"},{val:w.cal,lbl:"CAL",col:"#FF6B35"},{val:w.exercises,lbl:"EX.",col:PRIMARY}].map(s=>(
                  <div key={s.lbl} style={{ textAlign:"center" }}><div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:s.col,lineHeight:1 }}>{s.val}</div><div style={{ fontFamily:FONT,fontSize:10,color:"#444",letterSpacing:1,marginTop:3 }}>{s.lbl}</div></div>
                ))}
              </div>
            </div>
            <button onClick={()=>onSelect(picked)} style={{ width:"100%",padding:"16px 0",borderRadius:50,border:"none",background:lvl.color===PRIMARY?`linear-gradient(135deg,${PRIMARY},#0068CC)`:lvl.color,fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",boxShadow:`0 4px 22px ${lvl.color}55`,marginBottom:10 }}>LET'S DO THIS →</button>
            <button onClick={()=>setStep(0)} style={{ width:"100%",padding:"11px 0",borderRadius:50,border:"none",background:"transparent",fontFamily:FONT,fontSize:13,color:"#3a3a3a",cursor:"pointer" }}>← Change how I'm feeling</button>
          </div>
        ):null}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── WEIGHTS HUB PAGES ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────


// ── TYPE COLORS ──────────────────────────────────────────────────────────────
const TYPE_LABEL = { strength: "Strength", cardio: "Cardio", hiit: "HIIT", rest: "Rest" };

// ── CALENDAR DATA ────────────────────────────────────────────────────────────
// Workout types keyed by day of month (Dec 2024)
const CAL_DATA = {
  2:"strength", 4:"cardio", 5:"strength", 7:"strength",
  9:"cardio", 10:"strength", 12:"strength", 14:"hiit",
  16:"cardio", 17:"strength", 19:"strength", 21:"hiit",
  22:"strength", 23:"hiit", 24:"cardio", 26:"strength", 28:"strength", 31:"strength"
};

const DAY_STATS = {
  2:  { name:"Chest & Triceps",  type:"strength", duration:45, vol:"2,100kg", exercises:6, cal:320 },
  4:  { name:"HIIT Cardio",      type:"cardio",   duration:25, vol:"—",        exercises:5, cal:380 },
  5:  { name:"Back & Biceps",    type:"strength", duration:50, vol:"2,400kg", exercises:7, cal:340 },
  7:  { name:"Leg Day",          type:"strength", duration:55, vol:"3,200kg", exercises:6, cal:420 },
  9:  { name:"Steady State Run", type:"cardio",   duration:30, vol:"—",        exercises:1, cal:290 },
  10: { name:"Shoulder & Core",  type:"strength", duration:40, vol:"1,800kg", exercises:6, cal:300 },
  12: { name:"Full Body",        type:"strength", duration:60, vol:"2,800kg", exercises:8, cal:460 },
  14: { name:"HIIT Circuit",     type:"hiit",     duration:30, vol:"—",        exercises:6, cal:400 },
  16: { name:"Cycling",          type:"cardio",   duration:40, vol:"—",        exercises:1, cal:330 },
  17: { name:"Push Day",         type:"strength", duration:45, vol:"2,200kg", exercises:7, cal:350 },
  19: { name:"Pull Day",         type:"strength", duration:45, vol:"2,500kg", exercises:7, cal:360 },
  21: { name:"Tabata HIIT",      type:"hiit",     duration:25, vol:"—",        exercises:8, cal:420 },
  22: { name:"Upper Body",       type:"strength", duration:50, vol:"2,600kg", exercises:8, cal:382 },
  23: { name:"HIIT Intervals",   type:"hiit",     duration:30, vol:"—",        exercises:5, cal:390 },
  24: { name:"Rowing",           type:"cardio",   duration:35, vol:"—",        exercises:1, cal:310 },
  26: { name:"Lower Body",       type:"strength", duration:55, vol:"3,100kg", exercises:6, cal:440 },
  28: { name:"Chest & Shoulders",type:"strength", duration:45, vol:"2,300kg", exercises:7, cal:360 },
  31: { name:"New Year Strength",type:"strength", duration:60, vol:"2,900kg", exercises:8, cal:480 },
};

// ── EXERCISE LIBRARY ─────────────────────────────────────────────────────────
const EXERCISE_LIBRARY = {
  cardio: [
    { name:"Burpees",          mins:15, cal:305, intensity:"Very High Intensity",  img:"https://images.unsplash.com/photo-1599058945522-28d584b6f0ff?w=200&q=70" },
    { name:"Rowing Machine",   mins:15, cal:170, intensity:"High Intensity",       img:"https://images.unsplash.com/photo-1540497077202-7c8a3999166f?w=200&q=70" },
    { name:"Jumping Jacks",    mins:10, cal:90,  intensity:"Moderate Intensity",   img:"https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=200&q=70" },
    { name:"Stationary Bike",  mins:15, cal:200, intensity:"Very High Intensity",  img:"https://images.unsplash.com/photo-1521804906057-1df8fdb718b7?w=200&q=70" },
    { name:"Treadmill Running",mins:15, cal:150, intensity:"High Intensity",       img:"https://images.unsplash.com/photo-1594911772125-07fc7a2d8d9f?w=200&q=70" },
    { name:"Jump Rope",        mins:10, cal:130, intensity:"High Intensity",       img:"https://images.unsplash.com/photo-1607962837359-5e7e89f86776?w=200&q=70" },
  ],
  recovery: [
    { name:"Foam Rolling",     mins:10, cal:30,  intensity:"Low Intensity",        img:"https://images.unsplash.com/photo-1518611012118-696072aa579a?w=200&q=70" },
    { name:"Yoga Flow",        mins:20, cal:60,  intensity:"Low Intensity",        img:"https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=200&q=70" },
    { name:"Stretching",       mins:15, cal:40,  intensity:"Low Intensity",        img:"https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=200&q=70" },
    { name:"Walking",          mins:30, cal:120, intensity:"Low Intensity",        img:"https://images.unsplash.com/photo-1476480862126-209bfaa8edc8?w=200&q=70" },
  ],
  strength: [
    { name:"Bench Press",      mins:8,  cal:60,  intensity:"High Intensity",       img:"https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=200&q=70" },
    { name:"Deadlift",         mins:10, cal:80,  intensity:"Very High Intensity",  img:"https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=200&q=70" },
    { name:"Squat",            mins:10, cal:75,  intensity:"Very High Intensity",  img:"https://images.unsplash.com/photo-1574680096145-d05b474e2155?w=200&q=70" },
    { name:"Pull-ups",         mins:8,  cal:55,  intensity:"High Intensity",       img:"https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=200&q=70" },
    { name:"Shoulder Press",   mins:8,  cal:50,  intensity:"Moderate Intensity",   img:"https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=200&q=70" },
    { name:"Dumbbell Rows",    mins:8,  cal:55,  intensity:"Moderate Intensity",   img:"https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=200&q=70" },
  ],
  hiit: [
    { name:"Kettlebell Swings",mins:12, cal:180, intensity:"Very High Intensity",  img:"https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=200&q=70" },
    { name:"Box Jumps",        mins:10, cal:150, intensity:"High Intensity",       img:"https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=200&q=70" },
    { name:"Battle Ropes",     mins:8,  cal:120, intensity:"Very High Intensity",  img:"https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=200&q=70" },
    { name:"Mountain Climbers",mins:8,  cal:100, intensity:"High Intensity",       img:"https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=200&q=70" },
  ],
};

const ALL_EXERCISES = Object.values(EXERCISE_LIBRARY).flat();

// ── PERSONAL RECORDS ─────────────────────────────────────────────────────────
function RecordIcon({ name }) {
  const W="20",H="20",V="0 0 24 24",F="none",SW="2";
  if (name==="Bench Press")    return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (name==="Deadlift")       return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>;
  if (name==="5K Run")         return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
  if (name==="Squat")          return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><polyline points="17 21 12 13 7 21"/><polyline points="17 13 12 5 7 13"/></svg>;
  if (name==="Pull-ups")       return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M3 8h18"/></svg>;
  if (name==="Shoulder Press") return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><polyline points="12 19 12 5"/><polyline points="5 12 12 5 19 12"/></svg>;
  return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
const RECORDS = [
  { name:"Bench Press",   color:"#EF4444", bg:"#EF444422", val:"225 lbs", when:"3 days ago",  history:[185,195,205,210,220,225], dates:["Apr 1","Apr 5","Apr 10","Apr 15","Apr 20","Apr 24"] },
  { name:"Deadlift",      color:"#22C55E", bg:"#22C55E22", val:"315 lbs", when:"1 week ago",  history:[250,265,280,295,305,315], dates:["Mar 28","Apr 3","Apr 8","Apr 13","Apr 18","Apr 22"] },
  { name:"5K Run",        color:PRIMARY,   bg:`${PRIMARY}22`, val:"18:42",when:"2 weeks ago", history:[24,22,21,20,19,18.7],     dates:["Mar 25","Apr 2","Apr 7","Apr 12","Apr 17","Apr 19"] },
  { name:"Squat",         color:"#F97316", bg:"#F9731622", val:"275 lbs", when:"5 days ago",  history:[200,220,240,255,265,275], dates:["Mar 30","Apr 4","Apr 9","Apr 14","Apr 19","Apr 24"] },
  { name:"Pull-ups",      color:"#8B5CF6", bg:"#8B5CF622", val:"18 reps", when:"2 days ago",  history:[10,12,13,14,16,18],       dates:["Apr 2","Apr 7","Apr 11","Apr 16","Apr 21","Dec 27"] },
  { name:"Shoulder Press",color:"#EAB308", bg:"#EAB30822", val:"135 lbs", when:"1 week ago",  history:[95,105,110,115,125,135],  dates:["Apr 1","Apr 6","Apr 11","Apr 16","Apr 20","Apr 22"] },
];

// ── HISTORY ──────────────────────────────────────────────────────────────────
const HISTORY = [
  { date:"May 14", name:"Upper Body Strength", type:"strength", duration:45, vol:"2,300kg", cal:340 },
  { date:"May 12", name:"HIIT Cardio Burn",    type:"cardio",   duration:30, vol:"—",        cal:280 },
  { date:"May 10", name:"Leg Day",             type:"strength", duration:50, vol:"3,100kg", cal:380 },
  { date:"May 8",  name:"Push Day",            type:"strength", duration:45, vol:"2,500kg", cal:320 },
  { date:"May 6",  name:"Full Body HIIT",      type:"hiit",     duration:35, vol:"—",        cal:420 },
  { date:"May 3",  name:"Upper Body Strength", type:"strength", duration:45, vol:"2,200kg", cal:340 },
  { date:"May 1",  name:"HIIT Cardio Burn",    type:"cardio",   duration:30, vol:"—",        cal:280 },
  { date:"Apr 29", name:"Leg Day",             type:"strength", duration:50, vol:"3,000kg", cal:380 },
];

// ─────────────────────────────────────────────────────────────────────────────
// SHARED MICRO-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function BackBtn({ onBack, light }) {
  return (
    <button onClick={onBack} style={{ width:38,height:38,borderRadius:"50%",background:light?"rgba(0,0,0,0.15)":"#1a1a1a",border:`1px solid ${light?"rgba(255,255,255,0.3)":BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0 }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={light?"#fff":"#aaa"} strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
  );
}

function TypeBadge({ type, small }) {
  const color = TYPE_COLOR[type] || PRIMARY;
  return (
    <div style={{ background:`${color}22`,border:`1px solid ${color}55`,borderRadius:20,padding:small?"3px 10px":"5px 14px",display:"inline-block" }}>
      <span style={{ fontFamily:FONT,fontWeight:700,fontSize:small?10:11,color,letterSpacing:1 }}>{(TYPE_LABEL[type]||type).toUpperCase()}</span>
    </div>
  );
}

function VideoThumbSmall({ img }) {
  return (
    <div style={{ position:"relative",width:80,height:80,borderRadius:12,overflow:"hidden",flexShrink:0 }}>
      <img src={img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
      <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.3)",display:"flex",alignItems:"center",justifyContent:"center" }}>
        <div style={{ width:26,height:26,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
          <svg width="9" height="11" viewBox="0 0 9 11" fill="white"><polygon points="0,0 9,5.5 0,11"/></svg>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 1: CALENDAR VIEW
// ─────────────────────────────────────────────────────────────────────────────
function CalendarPage({ onBack }) {
  const { dark } = useTheme();
  const calScrollRef = useScrollPos("calendar");
  const T = dark ? DARK : LIGHT;
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState(null);
  const [animKey, setAnimKey]         = useState(0);
  const [slideDir, setSlideDir]       = useState(0);
  const touchStartX = useRef(null);
  const MAX_PAST = 3; // can go back 3 months, not forward past current

  const changeMonth = (next) => {
    if (next > 0 || next < -MAX_PAST) return; // 0=current, -MAX_PAST=oldest
    setSlideDir(next < monthOffset ? 1 : -1);
    setAnimKey(k => k+1);
    setMonthOffset(next);
    setSelectedDay(null);
  };

  const onTouchStart = e => { touchStartX.current = e.touches[0].clientX; };
  const onTouchEnd   = e => {
    if (!touchStartX.current) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 50) changeMonth(monthOffset + (dx < 0 ? -1 : 1));
    touchStartX.current = null;
  };

  const now = new Date(2026, 3, 1); // April 2026
  const displayDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const monthName = displayDate.toLocaleString("default", { month: "long", year: "numeric" });

  const firstDOW = displayDate.getDay();
  const daysInMonth = new Date(displayDate.getFullYear(), displayDate.getMonth() + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDOW; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const dayData = selectedDay ? DAY_STATS[selectedDay] : null;

  // Monthly averages
  const monthlyWorkouts = Object.keys(CAL_DATA).length;
  const totalCal = Object.values(DAY_STATS).reduce((s,d)=>s+d.cal,0);
  const avgCal = Math.round(totalCal / monthlyWorkouts);
  const restDays = daysInMonth - monthlyWorkouts;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      {/* Header */}
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
        <BackBtn onBack={onBack}/>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>CALENDAR</div>
        <div style={{ width:38,height:38,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15 14"/></svg>
        </div>
      </div>

      <div style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>
        {/* Month nav */}
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18 }}>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:22,color:"#fff" }}>{monthName}</div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>changeMonth(monthOffset+1)} disabled={monthOffset>=0}
              style={{ width:34,height:34,borderRadius:"50%",background:monthOffset>=0?"#111":CARD,border:`1px solid ${monthOffset>=0?"#1a1a1a":BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:monthOffset>=0?"not-allowed":"pointer",transition:"all 0.2s" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={monthOffset>=0?"#2a2a2a":"#888"} strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button onClick={()=>changeMonth(monthOffset-1)} disabled={monthOffset<=-MAX_PAST}
              style={{ width:34,height:34,borderRadius:"50%",background:monthOffset<=-MAX_PAST?"#111":CARD,border:`1px solid ${monthOffset<=-MAX_PAST?"#1a1a1a":BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:monthOffset<=-MAX_PAST?"not-allowed":"pointer",transition:"all 0.2s" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={monthOffset<=-MAX_PAST?"#2a2a2a":"#888"} strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>

        {/* Dot indicators */}
        <div style={{ display:"flex",justifyContent:"center",gap:5,marginBottom:14 }}>
          {[-MAX_PAST,-2,-1,0].map(i=>(
            <div key={i} style={{ width:i===monthOffset?18:6,height:6,borderRadius:3,background:i===monthOffset?PRIMARY:"#2a2a2a",transition:"all 0.2s" }}/>
          ))}
        </div>

        {/* Calendar grid — swipeable */}
        <div key={animKey} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          style={{ animation:animKey>0?(slideDir>0?"slideInFromRight":"slideInFromLeft")+" 0.3s ease both":"none" }}>
        <div style={{ background:"#fff",borderRadius:20,padding:"16px 12px",marginBottom:16 }}>
          {/* Day headers */}
          <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",marginBottom:10 }}>
            {["SUN","MON","TUE","WED","THU","FRI","SAT"].map(d=>(
              <div key={d} style={{ textAlign:"center",fontFamily:FONT,fontWeight:700,fontSize:10,color:"#aaa",letterSpacing:0.5 }}>{d}</div>
            ))}
          </div>
          {/* Day cells */}
          <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:"6px 2px" }}>
            {cells.map((day,i)=>{
              if(!day) return <div key={i}/>;
              const type = CAL_DATA[day];
              const color = type ? TYPE_COLOR[type] : null;
              const isSelected = selectedDay === day;
              return (
                <div key={i} onClick={()=>setSelectedDay(day===selectedDay?null:day)}
                  style={{ display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
                  <div style={{ width:38,height:38,borderRadius:"50%",background:isSelected?"#1a1a1a":color||"#f3f4f6",display:"flex",alignItems:"center",justifyContent:"center",border:isSelected?`2px solid ${color||PRIMARY}`:"none",transition:"all 0.2s" }}>
                    <span style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:color||isSelected?"#fff":"#666" }}>{day}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        </div>{/* end swipe zone */}
        {/* Legend */}
        <div style={{ display:"flex",gap:16,marginBottom:18,flexWrap:"wrap" }}>
          {[["#00A3FF","Strength"],["#F59E0B","Cardio"],["#6366F1","HIIT"],["#9CA3AF","Rest Day"]].map(([c,l])=>(
            <div key={l} style={{ display:"flex",alignItems:"center",gap:6 }}>
              <div style={{ width:10,height:10,borderRadius:"50%",background:c }}/>
              <span style={{ fontFamily:FONT,fontSize:12,color:"#aaa" }}>{l}</span>
            </div>
          ))}
        </div>

        {/* Day detail panel OR monthly stats */}
        {dayData ? (
          <div style={{ animation:"fadeUp 0.3s ease both" }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:14 }}>
              December {selectedDay}
            </div>
            <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:12 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
                <div>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff",marginBottom:4 }}>{dayData.name}</div>
                  <TypeBadge type={dayData.type}/>
                </div>
              </div>
              <div style={{ display:"flex",gap:0,borderRadius:14,overflow:"hidden",border:`1px solid ${BORDER}` }}>
                {[
                  {lbl:"Duration",   val:`${dayData.duration}m`, c:"#22C55E"},
                  {lbl:"Volume",     val:dayData.vol,             c:PRIMARY  },
                  {lbl:"Calories",   val:`${dayData.cal}`,        c:"#EF4444"},
                  {lbl:"Exercises",  val:dayData.exercises,       c:"#F97316"},
                ].map((s,i,arr)=>(
                  <div key={i} style={{ flex:1,textAlign:"center",padding:"12px 6px",borderRight:i<arr.length-1?`1px solid ${BORDER}`:0 }}>
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:s.c,lineHeight:1,marginBottom:4 }}>{s.val}</div>
                    <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",letterSpacing:0.5 }}>{s.lbl}</div>
                  </div>
                ))}
              </div>
            </div>
            <button onClick={()=>setSelectedDay(null)} style={{ width:"100%",padding:"13px 0",borderRadius:50,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888888",cursor:"pointer" }}>
              ← Back to monthly view
            </button>
          </div>
        ) : (
          <div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:14 }}>Monthly Stats</div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
              {[
                {svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>, val:avgCal, lbl:"Average Calories", bg:"#DC2626"},
                {svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, val:"60", lbl:"Avg Minutes", bg:"#16A34A"},
                {svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>, val:restDays, lbl:"Rest Days", bg:"#D97706"},
                {svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>, val:monthlyWorkouts, lbl:"Active Days", bg:"#16A34A"},
              ].map((s,i)=>(
                <div key={i} style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"22px 16px",textAlign:"center" }}>
                  <div style={{ width:50,height:50,borderRadius:"50%",background:s.bg,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px" }}>{s.svg}</div>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:30,color:"#fff",lineHeight:1,marginBottom:6 }}>{s.val}</div>
                  <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",lineHeight:1.3 }}>{s.lbl}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 2: WORKOUT HISTORY
// ─────────────────────────────────────────────────────────────────────────────
function WorkoutHistoryPage({ onBack }) {
  const { dark } = useTheme();
  const histScrollRef = useScrollPos("workout-history");
  const T = dark ? DARK : LIGHT;
  const [filter, setFilter] = useState("all");
  const filters = ["all","strength","cardio","hiit"];
  const { isPremium: histPremium } = useUser();
  const allHistory = filter==="all" ? HISTORY : HISTORY.filter(h=>h.type===filter);
  const filtered   = histPremium ? allHistory : allHistory.slice(0, 4); // free: last 4 entries (~14 days)

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
        <BackBtn onBack={onBack}/>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>WORKOUT HISTORY</div>
        <div style={{ width:38 }}/>
      </div>

      {/* Filter chips */}
      <div style={{ padding:"0 16px 14px",display:"flex",gap:8,flexShrink:0,overflowX:"auto" }}>
        {filters.map(f=>(
          <button key={f} onClick={()=>setFilter(f)} style={{ padding:"7px 16px",borderRadius:50,border:`1.5px solid ${filter===f?PRIMARY:BORDER}`,background:filter===f?`${PRIMARY}18`:"transparent",fontFamily:FONT,fontWeight:600,fontSize:12,color:filter===f?PRIMARY:"#555",cursor:"pointer",whiteSpace:"nowrap",transition:"all 0.2s",textTransform:"capitalize" }}>
            {f==="all"?"All Types":f.charAt(0).toUpperCase()+f.slice(1)}
          </button>
        ))}
      </div>

      <div style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>
        {!histPremium && (
          <div style={{ margin:"16px 0",background:"rgba(0,163,255,0.06)",border:"1px solid rgba(0,163,255,0.2)",borderRadius:16,padding:"16px 18px",display:"flex",alignItems:"center",gap:12 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>Showing last 14 days</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:2 }}>Upgrade to see your full workout history</div>
            </div>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:PRIMARY,letterSpacing:0.5 }}>PREMIUM →</div>
          </div>
        )}
        {filtered.map((h,i)=>(
          <div key={i} style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:12,display:"flex",alignItems:"center",gap:14,animation:`fadeUp 0.3s ease ${i*0.05}s both` }}>
            <div style={{ width:46,height:46,borderRadius:14,background:`${TYPE_COLOR[h.type]}22`,border:`1.5px solid ${TYPE_COLOR[h.type]}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:22 }}>
              {h.type==="strength"
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>
                : h.type==="cardio"
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                : h.type==="hiit"
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg>
              }
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",marginBottom:3 }}>{h.name}</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>{h.date} · {h.duration} min · {h.cal} cal</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <TypeBadge type={h.type} small/>
              {h.vol!=="—"&&<div style={{ fontFamily:FONT,fontSize:11,color:"#444",marginTop:4 }}>{h.vol}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 3: PERSONAL RECORDS
// ─────────────────────────────────────────────────────────────────────────────
function LineGraph({ data, dates, color }) {
  const [active, setActive] = useState(null); // index of tapped dot
  const W = 300, H = 140, PAD = { top:28, right:16, bottom:36, left:44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const minV = Math.min(...data) * 0.97;
  const maxV = Math.max(...data) * 1.03;

  const px = (i) => PAD.left + (i / (data.length - 1)) * innerW;
  const py = (v) => PAD.top  + innerH - ((v - minV) / (maxV - minV)) * innerH;

  const pathD = data.map((v,i) => `${i===0?"M":"L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const areaD = pathD + ` L${px(data.length-1).toFixed(1)},${(PAD.top+innerH).toFixed(1)} L${PAD.left.toFixed(1)},${(PAD.top+innerH).toFixed(1)} Z`;

  const yLabels = [Math.round(minV), Math.round((minV+maxV)/2), Math.round(maxV)];
  const xShow   = [0, Math.floor((data.length-1)/2), data.length-1];

  // Tooltip positioning — keep inside chart bounds
  const tipX = (i) => {
    const x = px(i);
    if (x < PAD.left + 30) return PAD.left + 30;
    if (x > W - 36)        return W - 36;
    return x;
  };

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:"visible" }}
      onClick={()=>setActive(null)}>
      <defs>
        <linearGradient id={`grad_${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.0"/>
        </linearGradient>
      </defs>

      {/* Grid lines + Y labels */}
      {yLabels.map((v,i) => (
        <g key={i}>
          <line x1={PAD.left} y1={py(v)} x2={PAD.left+innerW} y2={py(v)}
            stroke="#2a2a2a" strokeWidth="1" strokeDasharray="4,4"/>
          <text x={PAD.left-6} y={py(v)+4} textAnchor="end"
            fill="#555" fontSize="9" fontFamily="Montserrat,sans-serif">{v}</text>
        </g>
      ))}

      {/* Area + line */}
      <path d={areaD} fill={`url(#grad_${color.replace("#","")})`}/>
      <path d={pathD} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>

      {/* Vertical indicator for active dot */}
      {active!==null && (
        <line x1={px(active)} y1={PAD.top} x2={px(active)} y2={PAD.top+innerH}
          stroke={color} strokeWidth="1" strokeDasharray="3,3" strokeOpacity="0.6"/>
      )}

      {/* Data points — tappable */}
      {data.map((v,i) => {
        const isActive = active === i;
        const isLast   = i === data.length - 1;
        return (
          <g key={i} onClick={e=>{e.stopPropagation(); setActive(isActive?null:i);}}>
            {/* Larger hit area */}
            <circle cx={px(i)} cy={py(v)} r={14} fill="transparent" style={{cursor:"pointer"}}/>
            <circle cx={px(i)} cy={py(v)} r={isActive?6:isLast?5:3.5}
              fill={isActive||isLast?color:BG} stroke={color} strokeWidth="2"
              style={{transition:"r 0.15s"}}/>

            {/* Tooltip on tap */}
            {isActive && (
              <g>
                {/* Tooltip background */}
                <rect x={tipX(i)-28} y={py(v)-38} width={56} height={28} rx="6"
                  fill="#1a1a1a" stroke={color} strokeWidth="1"/>
                {/* Date */}
                <text x={tipX(i)} y={py(v)-26} textAnchor="middle"
                  fill="#888" fontSize="8" fontFamily="Montserrat,sans-serif">{dates[i]}</text>
                {/* Value */}
                <text x={tipX(i)} y={py(v)-14} textAnchor="middle"
                  fill={color} fontSize="11" fontWeight="700" fontFamily="Montserrat,sans-serif">{v}</text>
              </g>
            )}
          </g>
        );
      })}

      {/* Always-visible label on last point when not active */}
      {active === null && (
        <text x={px(data.length-1)} y={py(data[data.length-1])-10} textAnchor="middle"
          fill={color} fontSize="10" fontWeight="700" fontFamily="Montserrat,sans-serif">
          {data[data.length-1]}
        </text>
      )}

      {/* X axis labels */}
      {xShow.map(i => (
        <text key={i} x={px(i)} y={H-4} textAnchor="middle"
          fill={active===i?color:"#888888"} fontSize="9" fontFamily="Montserrat,sans-serif"
          fontWeight={active===i?"700":"400"}>
          {dates[i]}
        </text>
      ))}

      <line x1={PAD.left} y1={PAD.top+innerH} x2={PAD.left+innerW} y2={PAD.top+innerH} stroke="#2a2a2a" strokeWidth="1"/>
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top+innerH} stroke="#2a2a2a" strokeWidth="1"/>
    </svg>
  );
}

function PersonalRecordsPage({ onBack }) {
  const { dark } = useTheme();
  const recScrollRef = useScrollPos("personal-records");
  const T = dark ? DARK : LIGHT;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);

  const filtered = RECORDS.filter(r=>r.name.toLowerCase().includes(search.toLowerCase()));
  const rec = selected ? RECORDS.find(r=>r.name===selected) : null;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
        {rec
          ? <BackBtn onBack={()=>setSelected(null)}/>
          : <BackBtn onBack={onBack}/>
        }
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>{rec?"RECORD DETAIL":"PERSONAL RECORDS"}</div>
        <div style={{ width:38 }}/>
      </div>

      {!rec ? (
        <div ref={recScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>
          {/* Search */}
          <div style={{ background:CARD2,borderRadius:50,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",padding:"0 18px",height:50,marginBottom:20 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search exercises..." style={{ flex:1,background:"none",border:"none",fontFamily:FONT,fontSize:14,color:"#fff",outline:"none",marginLeft:10 }}/>
          </div>

          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#444",letterSpacing:1,marginBottom:12 }}>YOUR BEST PERFORMANCES</div>

          {filtered.map((r,i)=>(
            <div key={i} onClick={()=>setSelected(r.name)}
              style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:12,display:"flex",alignItems:"center",gap:14,cursor:"pointer",animation:`fadeUp 0.3s ease ${i*0.06}s both` }}>
              <div style={{ width:46,height:46,borderRadius:"50%",background:r.bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{<RecordIcon name={r.name}/>||"•"}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",marginBottom:3 }}>{r.name}</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Personal Best · {r.when}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:r.color }}>{r.val}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ flex:1,overflowY:"auto",padding:"0 16px 32px",animation:"fadeUp 0.3s ease both" }}>
          {/* Record hero */}
          <div style={{ background:`linear-gradient(135deg,${rec.bg},${rec.bg.slice(0,-2)}44)`,border:`1.5px solid ${rec.color}44`,borderRadius:22,padding:"28px 24px",textAlign:"center",marginBottom:16 }}>
            <div style={{ width:64,height:64,borderRadius:"50%",background:rec.bg,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto",marginBottom:12 }}><RecordIcon name={rec.name}/></div>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#fff",marginBottom:6 }}>{rec.name}</div>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:48,color:rec.color,lineHeight:1,marginBottom:8 }}>{rec.val}</div>
            <div style={{ fontFamily:FONT,fontSize:13,color:"rgba(255,255,255,0.5)" }}>Achieved {rec.when}</div>
          </div>

          {/* Progress over time — SVG Line Graph */}
          <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#444",letterSpacing:1,marginBottom:16 }}>PROGRESS OVER TIME</div>
            <LineGraph data={rec.history} dates={rec.dates} color={rec.color}/>
          </div>

          {/* Stats */}
          <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px" }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#444",letterSpacing:1,marginBottom:14 }}>STATS</div>
            {[
              {lbl:"Personal Best",       val:rec.val,  c:rec.color},
              {lbl:"Last Achieved",       val:rec.when, c:"#fff"},
              {lbl:"Total Sessions",      val:"24",     c:"#22C55E"},
              {lbl:"Improvement (30d)",   val:"+8%",    c:"#22C55E"},
            ].map((s,i,arr)=>(
              <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:i<arr.length-1?12:0,borderBottom:i<arr.length-1?`1px solid ${BORDER}`:0,marginBottom:i<arr.length-1?12:0 }}>
                <span style={{ fontFamily:FONT,fontSize:14,color:"#aaa" }}>{s.lbl}</span>
                <span style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:s.c }}>{s.val}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 4: CUSTOMIZE WORKOUT (FULL BUILDER FLOW)
// ─────────────────────────────────────────────────────────────────────────────
function TemplateIcon({ name }) {
  const W="20",H="20",V="0 0 24 24",F="none",SW="2";
  if (name==="Push / Pull / Legs") return <svg width={W} height={H} viewBox={V} fill={F} stroke="currentColor" strokeWidth={SW}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (name==="Upper / Lower")      return <svg width={W} height={H} viewBox={V} fill={F} stroke="currentColor" strokeWidth={SW}><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>;
  if (name==="Full Body")          return <svg width={W} height={H} viewBox={V} fill={F} stroke="currentColor" strokeWidth={SW}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>;
  return <svg width={W} height={H} viewBox={V} fill={F} stroke="currentColor" strokeWidth={SW}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
}
const TEMPLATES = [
  { name:"Push / Pull / Legs", days:3, desc:"Classic 3-day split" },
  { name:"Upper / Lower",      days:4, desc:"4-day muscle focus" },
  { name:"Full Body",          days:3, desc:"Total body each session" },
  { name:"Athlete",            days:5, desc:"5-day performance plan" },
];

function CustomizePage({ onBack }) {
  const [editDay, setEditDay] = useState(null);
  const [programme, setProgramme] = useState(
    WEEKLY_WORKOUTS.map(w=>({ ...w, exercises:[...w.exercises] }))
  );
  const [saved, setSaved] = useState(false);

  const typeColors = { STRENGTH:PRIMARY, CARDIO:"#EF4444", HIIT:"#F97316", RECOVERY:"#22C55E", REST:"#888" };

  const swapExercise = (dayIdx, exIdx, newName) => {
    setProgramme(p => {
      const copy = p.map(d=>({ ...d, exercises:[...d.exercises] }));
      copy[dayIdx].exercises[exIdx] = { ...copy[dayIdx].exercises[exIdx], name:newName };
      return copy;
    });
  };

  const toggleRestDay = (dayIdx) => {
    setProgramme(p => {
      const copy = p.map(d=>({ ...d }));
      copy[dayIdx].type = copy[dayIdx].type === "REST" ? "STRENGTH" : "REST";
      copy[dayIdx].name = copy[dayIdx].type === "REST" ? "Rest Day" : WEEKLY_WORKOUTS[dayIdx].name;
      return copy;
    });
  };

  if (editDay !== null) {
    const w = programme[editDay];
    const tc = typeColors[w.type] || PRIMARY;
    return (
      <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
        <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",gap:14,flexShrink:0 }}>
          <button onClick={()=>setEditDay(null)} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:1.5 }}>{w.day.toUpperCase()} — EDIT</div>
        </div>
        <div style={{ flex:1,overflowY:"auto",padding:"0 18px 40px" }}>
          {/* Rest day toggle */}
          <div style={{ background:"#fff",borderRadius:16,padding:"16px 18px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
            <div>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#111" }}>Rest Day</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:2 }}>Mark this day as rest & recovery</div>
            </div>
            <div onClick={()=>toggleRestDay(editDay)}
              style={{ width:48,height:28,borderRadius:14,background:w.type==="REST"?PRIMARY:"#e0e0e0",cursor:"pointer",position:"relative",transition:"background 0.2s" }}>
              <div style={{ position:"absolute",top:3,left:w.type==="REST"?22:3,width:22,height:22,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.2)" }}/>
            </div>
          </div>

          {w.type !== "REST" && (
            <div>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888",letterSpacing:1,marginBottom:10 }}>EXERCISES</div>
              {w.exercises.map((ex,ei)=>(
                <div key={ei} style={{ background:"#fff",borderRadius:14,padding:"14px 16px",marginBottom:10 }}>
                  <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:10 }}>
                    <div style={{ width:32,height:32,borderRadius:8,background:tc,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:FONT,fontWeight:800,fontSize:12,color:"#fff" }}>{ei+1}</div>
                    <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#111" }}>{ex.name}</div>
                  </div>
                  <input defaultValue={ex.detail}
                    onBlur={e=>swapExercise(editDay,ei,ex.name)}
                    style={{ width:"100%",background:"#f5f5f5",border:"1px solid #e0e0e0",borderRadius:10,padding:"8px 12px",fontFamily:FONT,fontSize:13,color:"#111",outline:"none" }}/>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",gap:14,flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:1.5 }}>EDIT PROGRAMME</div>
      </div>

      <div style={{ flex:1,overflowY:"auto",padding:"0 18px 40px" }}>
        <div style={{ fontFamily:FONT,fontSize:13,color:"#888",marginBottom:16,lineHeight:1.5 }}>
          Tap any day to adjust exercises or mark it as a rest day.
        </div>

        {programme.map((w,i)=>{
          const tc = typeColors[w.type] || PRIMARY;
          return (
            <div key={i} onClick={()=>setEditDay(i)}
              style={{ background:"#fff",borderRadius:18,padding:"16px 18px",marginBottom:12,cursor:"pointer",display:"flex",alignItems:"center",gap:14 }}>
              <div style={{ width:44,height:44,borderRadius:12,background:`${tc}18`,border:`1.5px solid ${tc}44`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                <span style={{ fontFamily:FONT,fontWeight:900,fontSize:12,color:tc }}>{w.day.replace("Day ","D")}</span>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#111" }}>{w.name}</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:2 }}>
                  {w.type==="REST" ? "Rest & Recovery" : `${w.exercises.length} exercises · ${w.duration} min`}
                </div>
              </div>
              <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                <div style={{ background:tc,borderRadius:20,padding:"4px 10px" }}>
                  <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#fff" }}>{w.type}</span>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </div>
            </div>
          );
        })}

        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>WORKOUT LOCATION</div>
          <ChipSel options={["Full Gym","Home","Outdoors","Mix"]} value={env2} onChange={setEnv2}/>
        </div>
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>EQUIPMENT ACCESS</div>
          <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
            {["Dumbbells","Barbell","Pull-up Bar","Resistance Bands","Kettlebells","No Equipment"].map(o=>(
              <button key={o} onClick={()=>setEquip(p=>p.includes(o)?p.filter(x=>x!==o):[...p,o])}
                style={{ padding:"10px 16px",borderRadius:50,border:`1.5px solid ${equip.includes(o)?PRIMARY:"#d0d0d0"}`,background:equip.includes(o)?PRIMARY:"#ffffff",fontFamily:FONT,fontWeight:equip.includes(o)?700:500,fontSize:12,color:equip.includes(o)?"#fff":"#333",cursor:"pointer",transition:"all 0.2s" }}>{o}</button>
            ))}
          </div>
        </div>
        <button onClick={()=>{ setSaved(true); setTimeout(()=>setSaved(false),2000); }}
          style={{ width:"100%",marginTop:8,padding:"15px 0",borderRadius:50,background:saved?"#22C55E":PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",transition:"background 0.3s" }}>
          {saved?"SAVED!":"SAVE PROGRAMME"}
        </button>
      </div>
    </div>
  );
}


const WEEKLY_WORKOUTS = [
  { day:"Day 1", name:"Upper Body Strength", type:"STRENGTH", duration:45, cal:340, exercises:[ {n:1,name:"Bench Press",      detail:"4 sets × 8 reps" }, {n:2,name:"Pull-ups",         detail:"4 sets × 12 reps"}, {n:3,name:"Shoulder Press",   detail:"3 sets × 10 reps"} ] },
  { day:"Day 2", name:"HIIT Cardio Burn",    type:"CARDIO",   duration:30, cal:280, exercises:[ {n:1,name:"Burpees",           detail:"3 sets × 15 reps"}, {n:2,name:"Jump Squats",      detail:"3 sets × 20 reps"}, {n:3,name:"Mountain Climbers", detail:"3 sets × 30s"   } ] },
  { day:"Day 3", name:"Leg Day",             type:"STRENGTH", duration:50, cal:380, exercises:[ {n:1,name:"Squats",            detail:"4 sets × 10 reps"}, {n:2,name:"Romanian DL",     detail:"3 sets × 10 reps"}, {n:3,name:"Leg Press",        detail:"3 sets × 12 reps"} ] },
  { day:"Day 4", name:"Push Day",            type:"STRENGTH", duration:45, cal:320, exercises:[ {n:1,name:"Incline Press",     detail:"4 sets × 10 reps"}, {n:2,name:"Dips",             detail:"3 sets × 12 reps"}, {n:3,name:"Tricep Ext",       detail:"3 sets × 15 reps"} ] },
  { day:"Day 5", name:"Full Body HIIT",      type:"HIIT",     duration:35, cal:420, exercises:[ {n:1,name:"Deadlifts",         detail:"3 sets × 8 reps" }, {n:2,name:"Box Jumps",       detail:"3 sets × 10 reps"}, {n:3,name:"Plank",            detail:"3 sets × 60s"   } ] },
];
const TODAY_IDX = new Date().getDay() === 0 ? 6 : new Date().getDay(); // tomorrow's session

function WeightsHub({ onLogout }){
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const [subPage, setSubPage] = useState(null);
  const [wIdx, setWIdx] = useState(TODAY_IDX);
  const weightsScrollRef = useScrollPos("weights-hub");
  const goBack = () => {
    setSubPage(null);
    requestAnimationFrame(()=>{
      if (weightsScrollRef.current && _scrollStore["weights-hub"]) {
        weightsScrollRef.current.scrollTop = _scrollStore["weights-hub"];
      }
    });
  };
  const [monthOffset, setMonthOffset] = useState(0);
  const swipeStartX = useRef(null);

  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentMonthIdx = (3 + monthOffset + 12) % 12; // April = 3
  const monthName = months[currentMonthIdx];

  // Per-month stats data — offset 0 = Nov (current), -1 = Oct (prev), etc.
  const MONTH_STATS = {
     0: { days:"12/16", streak:"3 week", rate:"75%",  pct:75,  label:"In progress" },
    "-1": { days:"16/16", streak:"4 week", rate:"100%", pct:100, label:"Completed!" },
    "-2": { days:"14/16", streak:"2 week", rate:"88%",  pct:88,  label:"Great month" },
    "-3": { days:"11/16", streak:"1 week", rate:"69%",  pct:69,  label:"Keep going"  },
  };
  const stats = MONTH_STATS[String(monthOffset)] || { days:"0/16", streak:"0 week", rate:"0%", pct:0, label:"No data" };

  // Swipe handlers for monthly card
  const onMonthSwipeStart = (e) => { swipeStartX.current = e.touches[0].clientX; };
  const onMonthSwipeEnd   = (e) => {
    if (!swipeStartX.current) return;
    const dx = e.changedTouches[0].clientX - swipeStartX.current;
    if (Math.abs(dx) > 50) setMonthOffset(o => dx < 0 ? o+1 : o-1);
    swipeStartX.current = null;
  };

  if (subPage === "profile")    return <ProfilePage         onBack={goBack} onLogout={()=>{ setSubPage(null); onLogout&&onLogout(); }}/>;
  if (subPage === "calendar")   return <CalendarPage       onBack={goBack}/>;
  if (subPage === "history")    return <WorkoutHistoryPage onBack={goBack}/>;
  if (subPage === "records")    return <PersonalRecordsPage onBack={goBack}/>;
  if (subPage === "customize")  return <CustomizePage       onBack={goBack}/>;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* ── TOP BAR ── */}
      <div style={{ padding:"50px 18px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:42,height:42,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>
          </div>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",letterSpacing:2 }}>WORKOUTS</div>
        </div>
        <button onClick={()=>setSubPage("profile")} style={{ width:40,height:40,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </button>
      </div>

      <div style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>

        {/* ── MONTHLY GOALS CARD ── */}
        <div onClick={()=>setSubPage("calendar")} onTouchStart={onMonthSwipeStart} onTouchEnd={onMonthSwipeEnd} style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"20px",marginBottom:14,cursor:"pointer",userSelect:"none" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
            <div>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:2 }}>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:24,color:PRIMARY }}>{monthName}</div>
                <div style={{ display:"flex",gap:4 }}>
                  <button onClick={e=>{e.stopPropagation();setMonthOffset(m=>m-1);}} style={{ background:"none",border:"none",cursor:"pointer",color:"#888888",fontSize:16,lineHeight:1 }}>‹</button>
                  <button onClick={e=>{e.stopPropagation();setMonthOffset(m=>m+1);}} style={{ background:"none",border:"none",cursor:"pointer",color:"#888888",fontSize:16,lineHeight:1 }}>›</button>
                </div>
              </div>
              <div style={{ fontFamily:FONT,fontWeight:600,fontSize:12,color:"#888888",letterSpacing:1 }}>MONTHLY GOALS</div>
            </div>
            <div style={{ width:42,height:42,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15 14"/></svg>
            </div>
          </div>

          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:16 }}>
            {[
              {val:stats.days,   lbl:"Days Completed",  c:"#FF6B35"},
              {val:stats.streak, lbl:"Current Streak",  c:"#EF4444"},
              {val:stats.rate,   lbl:"Completion Rate", c:"#22C55E"},
            ].map(s=>(
              <div key={s.lbl}>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:s.c,lineHeight:1,marginBottom:4 }}>{s.val}</div>
                <div style={{ fontFamily:FONT,fontSize:11,color:"#888888" }}>{s.lbl}</div>
              </div>
            ))}
          </div>
          {stats.label==="Completed!" && (
            <div style={{ fontFamily:FONT,fontSize:11,color:"#22C55E",fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:6 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
              {stats.label}
            </div>
          )}
          {/* Progress bar */}
          <div style={{ height:8,background:"#1a1a1a",borderRadius:8,overflow:"hidden" }}>
            <div style={{ height:"100%",width:`${stats.pct}%`,background:`linear-gradient(90deg,#22C55E,#16A34A)`,borderRadius:8,transition:"width 0.6s ease" }}/>
          </div>
          <div style={{ fontFamily:FONT,fontSize:10,color:"#444",marginTop:6,textAlign:"right" }}>Swipe to change month</div>
        </div>

        {/* ── NEXT WORKOUT ── */}
        {(()=>{ const w=WEEKLY_WORKOUTS[wIdx]; const typeColors={"STRENGTH":PRIMARY,"CARDIO":"#EF4444","HIIT":"#F97316","RECOVERY":"#22C55E","REST":"#888888"}; const tc=typeColors[w.type]||PRIMARY; return (
            <div style={{ background:"#fff",borderRadius:20,padding:"20px",marginBottom:14 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4 }}>
                <div>
                  <div style={{ fontFamily:FONT,fontSize:11,color:"#888",fontWeight:600,marginBottom:2 }}>NEXT SESSION</div>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:18,color:"#111" }}>{w.name}</div>
                </div>
                <div style={{ background:tc,borderRadius:20,padding:"5px 12px" }}>
                  <span style={{ fontFamily:FONT,fontWeight:800,fontSize:10,color:"#fff",letterSpacing:1 }}>{w.type}</span>
                </div>
              </div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginBottom:14 }}>{w.duration} min · {w.cal} cal · {w.day}</div>

              <div style={{ marginBottom:14 }}>
                <div style={{ fontFamily:FONT,fontSize:11,color:"#aaa",fontWeight:600,letterSpacing:0.5,marginBottom:8 }}>SWITCH DAY</div>
                <div style={{ display:"flex",gap:6,overflowX:"auto",paddingBottom:4 }}>
                  {WEEKLY_WORKOUTS.map((d,i)=>(
                    <button key={i} onClick={()=>setWIdx(i)}
                      style={{ flexShrink:0,padding:"6px 12px",borderRadius:20,border:`1.5px solid ${i===wIdx?tc:"#e0e0e0"}`,background:i===wIdx?tc:"transparent",fontFamily:FONT,fontWeight:600,fontSize:11,color:i===wIdx?"#fff":"#555",cursor:"pointer",transition:"all 0.2s" }}>
                      {d.day}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display:"flex",flexDirection:"column",gap:8,marginBottom:16 }}>
                {w.exercises.map(ex=>(
                  <div key={ex.n} style={{ background:"#f3f4f6",borderRadius:14,padding:"12px 16px",display:"flex",alignItems:"center",gap:12 }}>
                    <div style={{ width:34,height:34,borderRadius:10,background:tc,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontFamily:FONT,fontWeight:800,fontSize:12 }}>{ex.n}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#111" }}>{ex.name}</div>
                      <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:1 }}>{ex.detail}</div>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                  </div>
                ))}
              </div>

              <button style={{ width:"100%",padding:"15px 0",borderRadius:50,background:w.type==="REST"?"#f0f0f0":tc,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:w.type==="REST"?"#888":"#fff",cursor:"pointer",letterSpacing:1 }}>
                {w.type==="REST"?"REST DAY":"START WORKOUT"}
              </button>
            </div>
); })()}

        {/* ── QUICK ACCESS GRID ── */}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14 }}>
          <div onClick={()=>setSubPage("history")} style={{ background:"#fff",borderRadius:20,padding:"28px 16px",textAlign:"center",cursor:"pointer" }}>
            <div style={{ width:52,height:52,borderRadius:16,background:`${PRIMARY}18`,border:`1px solid ${PRIMARY}33`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px" }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15 14"/></svg>
            </div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#111",marginBottom:4 }}>Workout History</div>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>See your progress</div>
          </div>
          <div onClick={()=>setSubPage("customize")} style={{ background:"#fff",borderRadius:20,padding:"28px 16px",textAlign:"center",cursor:"pointer" }}>
            <div style={{ width:52,height:52,borderRadius:16,background:"#F9731618",border:"1px solid #F9731633",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px" }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#F97316" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
            </div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#111",marginBottom:4 }}>Customize</div>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Personalize workouts</div>
          </div>
        </div>

        {/* ── PERSONAL RECORDS ── */}
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff" }}>Personal Records</div>
            <button onClick={()=>setSubPage("records")} style={{ background:"none",border:"none",cursor:"pointer",fontFamily:FONT,fontWeight:700,fontSize:13,color:PRIMARY }}>View All</button>
          </div>
          {RECORDS.slice(0,3).map((r,i)=>(
            <div key={i} onClick={()=>setSubPage("records")} style={{ background:CARD2,borderRadius:14,padding:"14px 16px",marginBottom:i<2?10:0,display:"flex",alignItems:"center",gap:14,cursor:"pointer" }}>
              <div style={{ width:44,height:44,borderRadius:"50%",background:r.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0 }}>{r.icon}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",marginBottom:2 }}>{r.name}</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Personal Best</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:r.color }}>{r.val}</div>
                <div style={{ fontFamily:FONT,fontSize:11,color:"#444",marginTop:2 }}>{r.when}</div>
              </div>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}



// ─────────────────────────────────────────────────────────────────────────────
// ── NOTIFICATION DATA ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Notification icons rendered as SVG in NotificationsPage) {
// Notification icons rendered as SVG in NotificationsPage
function NotifIcon({ type }) {
  const p = { width:"18",height:"18",viewBox:"0 0 24 24",fill:"none",stroke:"#fff",strokeWidth:"2" };
  if (type==="workout")   return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (type==="goal")      return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>;
  if (type==="streak")    return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
  if (type==="nutrition") return <svg width={p.width} height={p.height} viewBox="0 0 24 24" fill="none" stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>;
  if (type==="steps")     return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
  if (type==="sleep")     return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>;
  if (type==="water")     return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></svg>;
  return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/></svg>;
}
const NOTIF_DATA = [
  { id:1, iconKey:"workout",  iconBg:PRIMARY,   title:"Workout Reminder",  time:"2m ago",    unread:true,  body:"Time for your evening strength training session. 30 minute strength workout." },
  { id:2, iconKey:"goal",     iconBg:PRIMARY,   title:"Goal Achieved!",    time:"15m ago",   unread:true,  body:"Congratulations! You've completed your weekly cardio goal of 150 minutes." },
  { id:3, iconKey:"streak",   iconBg:PRIMARY,   title:"Streak Alert",      time:"1h ago",    unread:true,  body:"You're on a 7-day workout streak! Keep it going to reach your 10-day milestone." },
  { id:4, iconKey:"nutrition",iconBg:"#374151", title:"Nutrition Tip",     time:"3h ago",    unread:false, body:"Don't forget to fuel your body. Try adding protein at least 30g within 30 minutes post-workout." },
  { id:5, iconKey:"steps",    iconBg:"#374151", title:"Daily Steps",       time:"5h ago",    unread:false, body:"Great job! You've walked 8,247 steps today. Only 1,753 more to reach your daily goal." },
  { id:6, iconKey:"sleep",    iconBg:"#374151", title:"Sleep Reminder",    time:"Yesterday", unread:false, body:"Time to wind down. Getting 7-8 hours of sleep helps with muscle recovery and performance." },
  { id:7, iconKey:"water",    iconBg:"#374151", title:"Hydration Check",   time:"Yesterday", unread:false, body:"You've logged 6 glasses of water today. Remember to stay hydrated throughout your workout." },
  { id:8, iconKey:"rest",     iconBg:"#374151", title:"Rest Day Scheduled",time:"2 days ago",unread:false, body:"Tomorrow is your scheduled rest day. Use this time for light stretching or meditation." },
];

// ── NOTIFICATION SETTINGS PAGE ────────────────────────────────────────────────

function NotifSectionIcon({ type }) {
  const s = { width:20, height:20, viewBox:"0 0 24 24", fill:"none", stroke:"#fff", strokeWidth:"2" };
  if (type==="workout") return <svg {...s}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (type==="meal")    return <svg {...s}><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>;
  if (type==="trophy")  return <svg {...s}><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M18 2H6v7a6 6 0 0012 0V2z"/></svg>;
  if (type==="users")   return <svg {...s}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>;
  if (type==="tag")     return <svg {...s}><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function NotifSettingsPage({ onBack }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const notifScrollRef = useScrollPos("notif-settings");
  const [settings, setSettings] = useState({
    dailyWorkout: true,  restDay: false,
    mealOfDay: true,     waterIntake: true,
    streakAlert: true,   aiSummary: false,    weeklyReport: true,
    newChallenges: false, challengeProgress: false,
    likesComments: false, directMessages: false, newFollowers: false,
    specialOffers: false, productRecs: false,
  });
  const toggle = k => setSettings(p => ({...p, [k]: !p[k]}));

  const Toggle = ({ k }) => (
    <button onClick={() => toggle(k)} style={{
      width:50, height:28, borderRadius:14, border:"none", cursor:"pointer",
      background: settings[k] ? PRIMARY : "#374151",
      position:"relative", transition:"background 0.25s", flexShrink:0,
    }}>
      <div style={{
        width:22, height:22, borderRadius:"50%", background:"#fff",
        position:"absolute", top:3,
        left: settings[k] ? 25 : 3,
        transition:"left 0.25s", boxShadow:"0 1px 4px rgba(0,0,0,0.3)",
      }}/>
    </button>
  );

  const Section = ({ icon, iconBg, title, sub, rows, locked }) => (
    <div style={{ background:"#fff", borderRadius:20, padding:"18px 20px", marginBottom:14 }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
        <div style={{ width:48, height:48, borderRadius:"50%", background:iconBg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><NotifSectionIcon type={icon}/></div>
        <div>
          <div style={{ fontFamily:FONT, fontWeight:800, fontSize:16, color:"#111" }}>{title}</div>
          <div style={{ fontFamily:FONT, fontSize:12, color:"#888888", marginTop:2 }}>{sub}</div>
        </div>
      </div>
      {locked ? (
        <div style={{ display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#f9f9f9",borderRadius:12,marginTop:4 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          <span style={{ fontFamily:FONT,fontSize:12,fontWeight:600,color:"#aaa" }}>Not available yet</span>
          <div style={{ marginLeft:"auto",background:"rgba(255,193,7,0.15)",border:"1px solid rgba(255,193,7,0.4)",borderRadius:20,padding:"2px 10px",fontFamily:FONT,fontWeight:700,fontSize:10,color:"#F59E0B" }}>SOON</div>
        </div>
      ) : rows.map((r, i) => (
        <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop: i>0 ? 14:0, borderTop: i>0 ? "1px solid #f0f0f0":0, marginTop: i>0 ? 14:0 }}>
          <div>
            <div style={{ fontFamily:FONT, fontWeight:600, fontSize:14, color:"#111" }}>{r.label}</div>
            <div style={{ fontFamily:FONT, fontSize:12, color:"#888888", marginTop:2 }}>{r.sub}</div>
          </div>
          <Toggle k={r.key}/>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ position:"absolute", inset:0, background:BG, display:"flex", flexDirection:"column" }}>
      {/* Header */}
      <div style={{ padding:"50px 18px 16px", display:"flex", alignItems:"center", gap:16, flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontFamily:FONT, fontWeight:900, fontSize:15, color:"#fff", letterSpacing:2 }}>NOTIFICATION SETTINGS</div>
      </div>

      <div ref={notifScrollRef} style={{ flex:1, overflowY:"auto", padding:"0 16px 32px" }}>
        {/* Info banner */}
        <div style={{ background:PRIMARY, borderRadius:16, padding:"14px 18px", marginBottom:20, display:"flex", gap:14, alignItems:"flex-start" }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:"rgba(255,255,255,0.2)", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
          <div>
            <div style={{ fontFamily:FONT, fontWeight:700, fontSize:14, color:"#fff", marginBottom:3 }}>Notification Timing</div>
            <div style={{ fontFamily:FONT, fontSize:13, color:"rgba(255,255,255,0.85)", lineHeight:1.55 }}>You can customize notification times in your device settings or by tapping on individual notification types above.</div>
          </div>
        </div>

        <Section icon="workout" iconBg={PRIMARY} title="Workout Reminders" sub="Get notified about your scheduled workouts"
          rows={[
            {key:"dailyWorkout", label:"Daily workout reminders",  sub:"Remind me to exercise daily"},
            {key:"restDay",      label:"Rest day reminders",       sub:"Gentle reminders for recovery days"},
          ]}
        />
        <Section icon="meal" iconBg="#F97316" title="Meal & Hydration" sub="Stay on top of nutrition and water goals"
          rows={[
            {key:"mealOfDay",    label:"Meal of the Day",          sub:"Daily reminder to check your meal suggestion"},
            {key:"waterIntake",  label:"Water intake reminders",   sub:"Stay hydrated throughout the day"},
          ]}
        />
        <Section icon="goal" iconBg="#22C55E" title="Progress & Insights" sub="Streaks, AI analysis and weekly reports"
          rows={[
            {key:"streakAlert",  label:"Streak alerts",            sub:"Warn me if I'm at risk of losing my streak"},
            {key:"aiSummary",    label:"AI summary ready",         sub:"Notify when my performance analysis is ready"},
            {key:"weeklyReport", label:"Weekly progress report",   sub:"Sunday summary of my training week"},
          ]}
        />
        <Section icon="challenge" iconBg="#A855F7" title="Challenge Updates" sub="Coming soon — challenge mode launches next update"
          locked={true}
          rows={[
            {key:"newChallenges",      label:"New challenges",      sub:"Notify when new challenges are available"},
            {key:"challengeProgress",  label:"Challenge progress",  sub:"Updates on your challenge achievements"},
          ]}
        />
        <Section icon="community" iconBg="#0EA5E9" title="Community" sub="Coming soon — social features launching soon"
          locked={true}
          rows={[
            {key:"likesComments",  label:"Likes and comments",     sub:"When someone likes or comments on your posts"},
            {key:"directMessages", label:"Direct messages",        sub:"New messages from other users"},
            {key:"newFollowers",   label:"New followers",          sub:"When someone starts following you"},
          ]}
        />
        <Section icon="promo" iconBg="#374151" title="Promotions & Offers" sub="Deals and personalised recommendations"
          rows={[
            {key:"specialOffers", label:"Special offers",          sub:"Discounts on premium features and gear"},
            {key:"productRecs",   label:"Product recommendations", sub:"Personalised fitness product suggestions"},
          ]}
        />
      </div>
    </div>
  );
}

// ── NOTIFICATIONS PAGE ────────────────────────────────────────────────────────
function NotificationsPage({ onBack, onMarkAllRead, unreadIds, onRead }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const [showSettings, setShowSettings] = useState(false);

  if (showSettings) return <NotifSettingsPage onBack={() => setShowSettings(false)}/>;

  return (
    <div style={{ position:"absolute", inset:0, background:BG, display:"flex", flexDirection:"column" }}>
      {/* Header */}
      <div style={{ padding:"50px 18px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, background:BG }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={"#888888"} strokeWidth="2.5"><polyline points="19 12 5 12"/><polyline points="12 5 5 12 12 19"/></svg>
        </button>
        <div style={{ fontFamily:FONT, fontWeight:900, fontSize:15, color:"#ffffff", letterSpacing:2 }}>NOTIFICATIONS</div>
        <button onClick={() => setShowSettings(true)} style={{ width:38, height:38, borderRadius:"50%", background:PRIMARY, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", border:"none" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </div>

      {/* Mark all read */}
      {unreadIds.length > 0 && (
        <div style={{ padding:"0 18px 10px", display:"flex", justifyContent:"flex-end", flexShrink:0 }}>
          <button onClick={onMarkAllRead} style={{ background:"none", border:"none", fontFamily:FONT, fontWeight:600, fontSize:13, color:PRIMARY, cursor:"pointer" }}>
            Mark all as read
          </button>
        </div>
      )}

      <div style={{ flex:1, overflowY:"auto", padding:"0 16px 32px" }}>
        {NOTIF_DATA.map((n, i) => {
          const isUnread = unreadIds.includes(n.id);
          return (
            <div key={n.id} onClick={() => onRead(n.id)}
              style={{ background: isUnread ? PRIMARY : "#fff", borderRadius:18, padding:"16px 18px", marginBottom:12, display:"flex", gap:14, alignItems:"flex-start", cursor:"pointer", animation:`fadeUp 0.3s ease ${i*0.05}s both`, transition:"background 0.2s" }}>
              {/* Icon */}
              <div style={{ width:44, height:44, borderRadius:"50%", background: isUnread ? "rgba(255,255,255,0.2)" : "#374151", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{n.icon}</div>
              {/* Body */}
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                  <div style={{ fontFamily:FONT, fontWeight:800, fontSize:15, color: isUnread ? "#fff" : "#111" }}>{n.title}</div>
                  <div style={{ fontFamily:FONT, fontSize:12, color: isUnread ? "rgba(255,255,255,0.75)" : "#aaa", marginLeft:8, whiteSpace:"nowrap", flexShrink:0 }}>{n.time}</div>
                </div>
                <div style={{ fontFamily:FONT, fontSize:13, color: isUnread ? "rgba(255,255,255,0.88)" : "#666", lineHeight:1.55 }}>{n.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// ── PROFILE PAGE + SUB-PAGES ─────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

function Toggle({ on, onToggle }) {
  return (
    <button onClick={onToggle} style={{ width:50,height:28,borderRadius:14,border:"none",cursor:"pointer",background:on?PRIMARY:"#374151",position:"relative",transition:"background 0.25s",flexShrink:0 }}>
      <div style={{ width:22,height:22,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:on?25:3,transition:"left 0.25s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)" }}/>
    </button>
  );
}

function ProfileRow({ icon, label, sub, onPress, danger }) {
  return (
    <button onClick={onPress} style={{ width:"100%",background:CARD,borderRadius:18,padding:"16px 18px",display:"flex",alignItems:"center",gap:14,border:`1px solid ${BORDER}`,cursor:"pointer",marginBottom:12,textAlign:"left",WebkitTapHighlightColor:"transparent" }}>
      <div style={{ width:44,height:44,borderRadius:"50%",background:`${PRIMARY}22`,border:`1px solid ${PRIMARY}44`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{icon}</div>
      <div style={{ flex:1,minWidth:0 }}>
        <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:danger?"#EF4444":"#ffffff",lineHeight:1.3,marginBottom:3 }}>{label}</div>
        <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",lineHeight:1.4 }}>{sub}</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={danger?"#EF4444":"#555"} strokeWidth="2" style={{flexShrink:0}}><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  );
}

// ── ACCOUNT SETTINGS — ALL SUB-PAGES ─────────────────────────────────────────

// ─ Shared dark input field ────────────────────────────────────────────────────
function DarkInput({ label, value, onChange, type="text", placeholder="" }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom:16 }}>
      {label && <div style={{ fontFamily:FONT,fontWeight:600,fontSize:12,color:"#888888",letterSpacing:0.5,marginBottom:7 }}>{label}</div>}
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
        style={{ width:"100%",background:CARD2,border:`1.5px solid ${focused?PRIMARY:BORDER}`,borderRadius:14,padding:"14px 16px",fontFamily:FONT,fontSize:14,fontWeight:500,color:"#ffffff",outline:"none",boxSizing:"border-box",transition:"border-color 0.2s" }}/>
    </div>
  );
}

// ─ Sub-page shell ────────────────────────────────────────────────────────────
function SubShell({ title, onBack, children }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",animation:"slideR 0.32s ease both" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",gap:14,flexShrink:0,background:BG }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={"#888888"} strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#ffffff",letterSpacing:1.5 }}>{title}</div>
      </div>
      <div style={{ flex:1,overflowY:"auto",padding:"0 16px 40px",background:BG }}>{children}</div>
    </div>
  );
}

// ─ SaveBtn ────────────────────────────────────────────────────────────────────
function SaveBtn({ onClick, saved, label="SAVE CHANGES" }) {
  return (
    <button onClick={onClick} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:saved?"#22C55E":`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",transition:"background 0.3s",boxShadow:`0 4px 20px rgba(0,163,255,0.35)`,marginTop:8 }}>
      {saved?"SAVED!":label}
    </button>
  );
}

// ─ Personal Details ───────────────────────────────────────────────────────────

function DetailFieldIcon({ type }) {
  const s = { width:18, height:18, viewBox:"0 0 24 24", fill:"none", stroke:"#888", strokeWidth:"2" };
  if (type==="scale") return <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>;
  if (type==="ruler") return <svg {...s}><path d="M21 6H3a2 2 0 00-2 2v8a2 2 0 002 2h18a2 2 0 002-2V8a2 2 0 00-2-2z"/><line x1="7" y1="6" x2="7" y2="10"/><line x1="12" y1="6" x2="12" y2="12"/><line x1="17" y1="6" x2="17" y2="10"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function PersonalDetailsPage({ onBack }) {
  const { user, setUser } = useUser();
  const [name,  setName]  = useState(user.name);
  const [age,   setAge]   = useState(user.age);
  const [gender,setGender]= useState(user.gender);
  const [weight,setWeight]= useState(user.weight);
  const [height,setHeight]= useState(user.height);
  const [unit,  setUnit]  = useState("kg/cm");
  const [saved, setSaved] = useState(false);

  const save = () => { setUser(u=>({...u,name,age,gender,weight,height})); setSaved(true); setTimeout(()=>setSaved(false),2200); };

  return (
    <SubShell title="PERSONAL DETAILS" onBack={onBack}>
      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"20px",marginBottom:14 }}>
        <DarkInput label="FULL NAME" value={name} onChange={setName}/>
        <DarkInput label="AGE" value={age} onChange={setAge} type="number"/>
        <div style={{ marginBottom:16 }}>
          <div style={{ fontFamily:FONT,fontWeight:600,fontSize:12,color:"#888888",letterSpacing:0.5,marginBottom:8 }}>GENDER</div>
          <div style={{ display:"flex",gap:8 }}>
            {["Male","Female","Other","N/A"].map(g=>(
              <button key={g} onClick={()=>setGender(g)} style={{ flex:1,padding:"11px 0",borderRadius:12,border:`1.5px solid ${gender===g?PRIMARY:BORDER}`,background:gender===g?`${PRIMARY}18`:"transparent",fontFamily:FONT,fontWeight:600,fontSize:12,color:gender===g?PRIMARY:"#555",cursor:"pointer",transition:"all 0.2s" }}>{g}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"20px",marginBottom:14 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888",letterSpacing:0.5 }}>BODY STATS</div>
          <div style={{ display:"flex",background:"#1a1a1a",borderRadius:20,padding:3 }}>
            {["kg/cm","lbs/in"].map(u=>(
              <button key={u} onClick={()=>setUnit(u)} style={{ padding:"5px 12px",borderRadius:16,border:"none",background:unit===u?PRIMARY:"transparent",fontFamily:FONT,fontWeight:600,fontSize:11,color:unit===u?"#fff":"#555",cursor:"pointer",transition:"all 0.2s" }}>{u}</button>
            ))}
          </div>
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
          {[{lbl:`WEIGHT (${unit.split("/")[0].toUpperCase()})`,val:weight,set:setWeight,ico:"scale"},
            {lbl:`HEIGHT (${unit.split("/")[1].toUpperCase()})`,val:height,set:setHeight,ico:"ruler"}].map(f=>(
            <div key={f.lbl}>
              <div style={{ fontFamily:FONT,fontWeight:600,fontSize:11,color:"#888888",marginBottom:6 }}>{f.lbl}</div>
              <div style={{ background:"#1e1e1e",border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:8 }}>
                <DetailFieldIcon type={f.ico}/>
                <input type="number" value={f.val} onChange={e=>f.set(e.target.value)}
                  style={{ flex:1,background:"none",border:"none",fontFamily:FONT,fontSize:16,fontWeight:700,color:"#fff",outline:"none",width:"100%" }}/>
              </div>
            </div>
          ))}
        </div>
      </div>
      <SaveBtn onClick={save} saved={saved}/>
    </SubShell>
  );
}

// ─ Fitness Goal ───────────────────────────────────────────────────────────────

function GoalIcon({ type }) {
  const s = { width:22, height:22, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:"2" };
  if (type==="fire")    return <svg {...s}><path d="M12 2c0 6-6 8-6 14a6 6 0 0012 0c0-6-6-8-6-14z"/></svg>;
  if (type==="muscle")  return <svg {...s}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>;
  if (type==="bolt")    return <svg {...s}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
  if (type==="run")     return <svg {...s}><circle cx="12" cy="5" r="2"/><path d="M10 22v-6l-2-3 4-4 2 3h4"/><path d="M10 13l-4 2"/></svg>;
  if (type==="star")    return <svg {...s}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
  if (type==="sparkle") return <svg {...s}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function FitnessGoalPage({ onBack }) {
  const { user, setUser } = useUser();
  const [goal, setGoal]   = useState(user.goal);
  const [level, setLevel] = useState(user.level);
  const [days, setDays]   = useState(user.days);
  const [saved, setSaved] = useState(false);

  const goals = [
    { key:"Lose Weight",                ico:"fire", desc:"Burn fat and reduce body weight" },
    { key:"Build Muscle",               ico:"muscle", desc:"Increase muscle mass and strength" },
    { key:"Weight Loss & Muscle Gain",  ico:"bolt", desc:"Body recomposition — best of both" },
    { key:"Improve Endurance",          ico:"run", desc:"Cardio fitness and stamina" },
    { key:"Stay Active",                ico:"star", desc:"Maintain a healthy active lifestyle" },
    { key:"Get Toned",                  ico:"sparkle", desc:"Lean, defined physique" },
  ];

  return (
    <SubShell title="FITNESS GOAL" onBack={onBack}>
      <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",marginBottom:18 }}>Choose your primary fitness goal. This shapes your entire workout plan.</div>

      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:16 }}>
        {goals.map(g=>(
          <button key={g.key} onClick={()=>setGoal(g.key)} style={{ display:"flex",alignItems:"center",gap:14,padding:"14px 18px",borderRadius:18,border:`2px solid ${goal===g.key?PRIMARY:BORDER}`,background:goal===g.key?`${PRIMARY}12`:CARD,cursor:"pointer",textAlign:"left",transition:"all 0.2s" }}>
            <div style={{ width:44,height:44,borderRadius:14,background:goal===g.key?`${PRIMARY}25`:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background 0.18s" }}><GoalIcon type={g.ico}/></div>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:goal===g.key?PRIMARY:"#fff" }}>{g.key}</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{g.desc}</div>
            </div>
            {goal===g.key&&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
          </button>
        ))}
      </div>

      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:16 }}>
        <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#888888",letterSpacing:1,marginBottom:14 }}>EXPERIENCE LEVEL</div>
        <div style={{ display:"flex",gap:8 }}>
          {["Beginner","Intermediate","Advanced"].map(l=>(
            <button key={l} onClick={()=>setLevel(l)} style={{ flex:1,padding:"12px 0",borderRadius:12,border:`1.5px solid ${level===l?PRIMARY:BORDER}`,background:level===l?`${PRIMARY}18`:"transparent",fontFamily:FONT,fontWeight:600,fontSize:12,color:level===l?PRIMARY:"#555",cursor:"pointer",transition:"all 0.2s" }}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:16 }}>
        <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#888888",letterSpacing:1,marginBottom:14 }}>DAYS PER WEEK</div>
        <div style={{ display:"flex",gap:8 }}>
          {[2,3,4,5].map(d=>(
            <button key={d} onClick={()=>setDays(d)} style={{ flex:1,padding:"14px 0",borderRadius:14,border:`2px solid ${days===d?PRIMARY:BORDER}`,background:days===d?PRIMARY:"transparent",fontFamily:FONT,fontWeight:600,fontSize:16,color:days===d?"#fff":"#555",cursor:"pointer",transition:"all 0.2s" }}>{d}</button>
          ))}
        </div>
      </div>

      <SaveBtn onClick={()=>{setUser(u=>({...u,goal,level,days}));setSaved(true);setTimeout(()=>setSaved(false),2200);}} saved={saved}/>
    </SubShell>
  );
}

// ─ Change Email ───────────────────────────────────────────────────────────────
function ChangeEmailPage({ onBack }) {
  const [email, setEmail] = useState("john@example.com");
  const [newEmail, setNewEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);
  const match = newEmail && newEmail===confirm;

  return (
    <SubShell title="CHANGE EMAIL" onBack={onBack}>
      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"20px",marginBottom:14 }}>
        <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",marginBottom:18,lineHeight:1.5 }}>Current: <span style={{ color:PRIMARY,fontWeight:600 }}>{email}</span></div>
        <DarkInput label="NEW EMAIL" value={newEmail} onChange={setNewEmail} type="email" placeholder="Enter new email address"/>
        <DarkInput label="CONFIRM NEW EMAIL" value={confirm} onChange={setConfirm} type="email" placeholder="Confirm new email address"/>
        {confirm&&!match&&<div style={{ fontFamily:FONT,fontSize:12,color:"#EF4444",marginBottom:8,marginTop:-8 }}>Emails do not match</div>}
        {match&&<div style={{ fontFamily:FONT,fontSize:12,color:"#22C55E",marginBottom:8,marginTop:-8 }}>Emails match</div>}
      </div>
      <SaveBtn onClick={()=>{if(match){setSaved(true);setEmail(newEmail);setNewEmail("");setConfirm("");setTimeout(()=>setSaved(false),2200);}}} saved={saved} label="UPDATE EMAIL"/>
    </SubShell>
  );
}

// ─ Change Password ────────────────────────────────────────────────────────────
function ChangePasswordPage({ onBack }) {
  const [current, setCurrent]   = useState("");
  const [newPass, setNewPass]   = useState("");
  const [confirm, setConfirm]   = useState("");
  const [saved, setSaved]       = useState(false);
  const strong = newPass.length >= 8;
  const match  = newPass && newPass===confirm;

  const strength = newPass.length === 0 ? 0 : newPass.length < 6 ? 1 : newPass.length < 10 ? 2 : 3;
  const strengthColors = ["#EF4444","#F97316","#EAB308","#22C55E"];
  const strengthLabels = ["","Weak","Fair","Strong"];

  return (
    <SubShell title="CHANGE PASSWORD" onBack={onBack}>
      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"20px",marginBottom:14 }}>
        <DarkInput label="CURRENT PASSWORD" value={current} onChange={setCurrent} type="password" placeholder="Enter current password"/>
        <DarkInput label="NEW PASSWORD" value={newPass} onChange={setNewPass} type="password" placeholder="Min 8 characters"/>
        {newPass.length>0&&(
          <div style={{ marginBottom:16,marginTop:-8 }}>
            <div style={{ display:"flex",gap:4,marginBottom:4 }}>
              {[1,2,3].map(i=><div key={i} style={{ flex:1,height:4,borderRadius:2,background:strength>=i?strengthColors[strength]:"#2a2a2a",transition:"background 0.3s" }}/>)}
            </div>
            <div style={{ fontFamily:FONT,fontSize:11,color:strengthColors[strength] }}>{strengthLabels[strength]}</div>
          </div>
        )}
        <DarkInput label="CONFIRM NEW PASSWORD" value={confirm} onChange={setConfirm} type="password" placeholder="Repeat new password"/>
        {confirm&&<div style={{ fontFamily:FONT,fontSize:12,color:match?"#22C55E":"#EF4444",marginTop:-10,marginBottom:8 }}>{match?"Passwords match":"Passwords do not match"}</div>}
      </div>
      <SaveBtn onClick={()=>{if(match&&strong&&current){setSaved(true);setCurrent("");setNewPass("");setConfirm("");setTimeout(()=>setSaved(false),2200);}}} saved={saved} label="UPDATE PASSWORD"/>
    </SubShell>
  );
}

// ─ Payment Method ─────────────────────────────────────────────────────────────
function PaymentMethodPage({ onBack }) {
  const [selected, setSelected] = useState("visa");
  const [adding, setAdding]     = useState(false);
  const [cardNum, setCardNum]   = useState("");
  const [expiry, setExpiry]     = useState("");
  const [cvv, setCvv]           = useState("");
  const [name, setName]         = useState("");
  const [saved, setSaved]       = useState(false);

  const cards = [
    { key:"visa",   label:"Visa ending in 4242",   exp:"12/26", ico:"card", color:"#1A1FD6" },
    { key:"mc",     label:"Mastercard ending in 8891", exp:"08/25", ico:"card", color:"#EB001B" },
  ];

  return (
    <SubShell title="PAYMENT METHOD" onBack={onBack}>
      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#888888",letterSpacing:1,marginBottom:12 }}>SAVED CARDS</div>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        {cards.map(c=>(
          <button key={c.key} onClick={()=>setSelected(c.key)} style={{ display:"flex",alignItems:"center",gap:14,padding:"16px 18px",borderRadius:18,border:`2px solid ${selected===c.key?PRIMARY:BORDER}`,background:selected===c.key?`${PRIMARY}12`:CARD,cursor:"pointer",textAlign:"left",transition:"all 0.2s" }}>
            <div style={{ width:44,height:30,borderRadius:8,background:c.color,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
              <span style={{ fontFamily:FONT,fontWeight:900,fontSize:10,color:"#fff",letterSpacing:1 }}>{c.key.toUpperCase()}</span>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff" }}>{c.label}</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>Expires {c.exp}</div>
            </div>
            {selected===c.key&&<div style={{ width:22,height:22,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}><svg width="12" height="9" viewBox="0 0 12 9" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="1,4.5 4.5,8 11,1"/></svg></div>}
          </button>
        ))}
      </div>

      {!adding ? (
        <button onClick={()=>setAdding(true)} style={{ width:"100%",padding:"14px 0",borderRadius:50,background:"transparent",border:`1.5px dashed ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:16 }}>
          <span style={{ fontSize:18 }}>+</span> Add New Card
        </button>
      ) : (
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"20px",marginBottom:16 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888",marginBottom:14 }}>ADD NEW CARD</div>
          <DarkInput label="CARD NUMBER" value={cardNum} onChange={setCardNum} placeholder="1234 5678 9012 3456"/>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
            <DarkInput label="EXPIRY" value={expiry} onChange={setExpiry} placeholder="MM/YY"/>
            <DarkInput label="CVV" value={cvv} onChange={setCvv} placeholder="•••"/>
          </div>
          <DarkInput label="CARDHOLDER NAME" value={name} onChange={setName} placeholder="Name on card"/>
          <div style={{ display:"flex",gap:10 }}>
            <button onClick={()=>setAdding(false)} style={{ flex:1,padding:"13px 0",borderRadius:50,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888888",cursor:"pointer" }}>Cancel</button>
            <button onClick={()=>{setSaved(true);setAdding(false);setTimeout(()=>setSaved(false),2200);}} style={{ flex:2,padding:"13px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff",cursor:"pointer" }}>Add Card</button>
          </div>
        </div>
      )}
      {saved&&<div style={{ background:"#0c1c0c",border:"1px solid #22C55E44",borderRadius:14,padding:"12px 16px",textAlign:"center",fontFamily:FONT,fontWeight:700,fontSize:13,color:"#22C55E" }}>✓ Card saved successfully</div>}
    </SubShell>
  );
}

// ─ Billing History ────────────────────────────────────────────────────────────
function BillingHistoryPage({ onBack }) {
  const bills = [
    { date:"Mar 15, 2026", desc:"Premium Plan",  amount:"$9.99",  status:"Paid" },
    { date:"Feb 15, 2026", desc:"Premium Plan",  amount:"$9.99",  status:"Paid" },
    { date:"Jan 15, 2026", desc:"Premium Plan",  amount:"$9.99",  status:"Paid" },
    { date:"Dec 15, 2025", desc:"Premium Plan",  amount:"$9.99",  status:"Paid" },

  ];
  return (
    <SubShell title="BILLING HISTORY" onBack={onBack}>
      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"0 18px",overflow:"hidden" }}>
        {bills.map((b,i)=>(
          <div key={i} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 0",borderBottom:i<bills.length-1?`1px solid ${BORDER}`:"none" }}>
            <div>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",marginBottom:3 }}>{b.desc}</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>{b.date}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",marginBottom:4 }}>{b.amount}</div>
              <div style={{ background:"#22C55E18",border:"1px solid #22C55E44",borderRadius:20,padding:"2px 10px",display:"inline-block" }}>
                <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#22C55E",letterSpacing:0.5 }}>{b.status}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </SubShell>
  );
}

// ─ Upgrade Plan ───────────────────────────────────────────────────────────────
function UpgradePlanPage({ onBack }) {
  const [selected, setSelected] = useState("annual");
  const [confirmed, setConfirmed] = useState(false);

  const plans = [
    { key:"monthly", label:"Monthly", price:"$9.99", period:"/month", savings:null,       badge:null },
    { key:"annual",  label:"Annual",  price:"$69.99",period:"/year",  savings:"Save 50%", badge:"BEST VALUE" },

  ];

  const features = ["Unlimited workout videos","AI-powered summaries","Money-backed challenges","Advanced analytics","Priority support","Custom workout builder"];

  return (
    <SubShell title="UPGRADE PLAN" onBack={onBack}>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        {plans.map(p=>(
          <button key={p.key} onClick={()=>setSelected(p.key)} style={{ display:"flex",alignItems:"center",padding:"16px 18px",borderRadius:18,border:`2px solid ${selected===p.key?PRIMARY:BORDER}`,background:selected===p.key?`${PRIMARY}12`:CARD,cursor:"pointer",textAlign:"left",gap:14,transition:"all 0.2s",position:"relative",overflow:"hidden" }}>
            {p.badge&&<div style={{ position:"absolute",top:0,right:0,background:PRIMARY,padding:"4px 12px",borderRadius:"0 16px 0 12px",fontFamily:FONT,fontWeight:800,fontSize:10,color:"#fff",letterSpacing:1 }}>{p.badge}</div>}
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:selected===p.key?PRIMARY:"#fff",marginBottom:2 }}>{p.label}</div>
              {p.savings&&<div style={{ fontFamily:FONT,fontSize:12,color:"#22C55E",marginBottom:4 }}>{p.savings}</div>}
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:selected===p.key?PRIMARY:"#fff" }}>{p.price}</div>
              <div style={{ fontFamily:FONT,fontSize:11,color:"#888888" }}>{p.period}</div>
            </div>
          </button>
        ))}
      </div>

      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:16 }}>
        <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#888888",letterSpacing:1,marginBottom:14 }}>ALL PLANS INCLUDE</div>
        {features.map((f,i)=>(
          <div key={i} style={{ display:"flex",alignItems:"center",gap:12,marginBottom:i<features.length-1?12:0 }}>
            <div style={{ width:20,height:20,borderRadius:"50%",background:`${PRIMARY}20`,border:`1px solid ${PRIMARY}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke={PRIMARY} strokeWidth="2"><polyline points="1,4 3.5,7 9,1"/></svg>
            </div>
            <span style={{ fontFamily:FONT,fontSize:14,color:"rgba(255,255,255,0.8)" }}>{f}</span>
          </div>
        ))}
      </div>

      {!confirmed ? (
        <button onClick={()=>setConfirmed(true)} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",boxShadow:`0 4px 24px ${PRIMARY}55` }}>
          UPGRADE NOW →
        </button>
      ) : (
        <div style={{ background:"#0c1c0c",border:"1px solid #22C55E44",borderRadius:18,padding:"20px",textAlign:"center",animation:"fadeUp 0.3s ease both" }}>
          <div style={{ width:64,height:64,borderRadius:"50%",background:"#22C55E22",border:"1px solid #22C55E55",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px" }}><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#22C55E",marginBottom:6 }}>You're now Premium!</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#888888" }}>Welcome to the full VTRX experience.</div>
        </div>
      )}
    </SubShell>
  );
}

// ─ Cancel Subscription ────────────────────────────────────────────────────────
function CancelSubscriptionPage({ onBack }) {
  const [step, setStep]     = useState(0); // 0=confirm 1=reason 2=done
  const [reason, setReason] = useState("");
  const reasons = ["Too expensive","Not using it enough","Missing features I need","Found a better app","Technical issues","Other"];

  return (
    <SubShell title="CANCEL SUBSCRIPTION" onBack={onBack}>
      {step === 0 && (
        <div style={{ animation:"fadeUp 0.3s ease both" }}>
          <div style={{ background:"#1c0c0c",border:"1px solid #EF444433",borderRadius:20,padding:"24px 20px",textAlign:"center",marginBottom:20 }}>
            <div style={{ width:64,height:64,borderRadius:"50%",background:"#EF444422",border:"1px solid #EF444455",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px" }}><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:18,color:"#fff",marginBottom:8 }}>We're sorry to see you go</div>
            <div style={{ fontFamily:FONT,fontSize:14,color:"#888888",lineHeight:1.65 }}>Cancelling will end your Premium access on Dec 15, 2024. You'll lose access to AI summaries, unlimited videos, and challenges.</div>
          </div>
          <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:16 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888",marginBottom:14 }}>BEFORE YOU GO, YOU'LL LOSE:</div>
            {["Unlimited workout videos","AI-powered summaries","Money-backed challenges","Advanced analytics"].map((f,i)=>(
              <div key={i} style={{ display:"flex",alignItems:"center",gap:12,marginBottom:i<3?12:0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                <span style={{ fontFamily:FONT,fontSize:14,color:"#aaa" }}>{f}</span>
              </div>
            ))}
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
            <button onClick={onBack} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer" }}>
              Keep My Premium
            </button>
            <button onClick={()=>setStep(1)} style={{ width:"100%",padding:"14px 0",borderRadius:50,background:"transparent",border:"1px solid #EF444444",fontFamily:FONT,fontWeight:600,fontSize:13,color:"#EF4444",cursor:"pointer" }}>
              Continue to Cancel
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div style={{ animation:"fadeUp 0.3s ease both" }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:16,color:"#fff",marginBottom:6 }}>Why are you leaving?</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",marginBottom:18 }}>Your feedback helps us improve VTRX for everyone.</div>
          <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
            {reasons.map(r=>(
              <button key={r} onClick={()=>setReason(r)} style={{ display:"flex",alignItems:"center",gap:14,padding:"14px 18px",borderRadius:14,border:`1.5px solid ${reason===r?"#EF4444":BORDER}`,background:reason===r?"rgba(239,68,68,0.08)":CARD,cursor:"pointer",textAlign:"left",transition:"all 0.2s" }}>
                <div style={{ width:20,height:20,borderRadius:"50%",border:`2px solid ${reason===r?"#EF4444":"#333"}`,background:reason===r?"#EF4444":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s" }}>
                  {reason===r&&<div style={{ width:8,height:8,borderRadius:"50%",background:"#fff" }}/>}
                </div>
                <span style={{ fontFamily:FONT,fontWeight:600,fontSize:14,color:reason===r?"#EF4444":"#fff" }}>{r}</span>
              </button>
            ))}
          </div>
          <button onClick={()=>reason&&setStep(2)} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:reason?"#EF4444":"#1a1a1a",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:reason?"#fff":"#333",letterSpacing:1,cursor:reason?"pointer":"not-allowed" }}>
            CONFIRM CANCELLATION
          </button>
        </div>
      )}

      {step === 2 && (
        <div style={{ textAlign:"center",paddingTop:40,animation:"fadeUp 0.4s ease both" }}>
          <div style={{ width:72,height:72,borderRadius:"50%",background:"#22C55E22",border:"2px solid #22C55E55",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px" }}><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",marginBottom:8 }}>Subscription Cancelled</div>
          <div style={{ fontFamily:FONT,fontSize:14,color:"#888888",lineHeight:1.65,marginBottom:32 }}>Your Premium access continues until Dec 15, 2024. We hope to see you back soon.</div>
          <button onClick={onBack} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer" }}>
            Back to Account
          </button>
        </div>
      )}
    </SubShell>
  );
}

// ── DARK MODE ROW ────────────────────────────────────────────────────────────
function DarkModeRow() {
  const { dark, toggle } = useTheme();
  return (
    <div style={{ display:"flex",alignItems:"center",gap:14,padding:"15px 0",borderTop:"1px solid #f0f0f0" }}>
      <div style={{ width:20,height:20,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
        {dark
          ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
          : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        }
      </div>
      <div style={{ flex:1 }}>
        <div style={{ fontFamily:FONT,fontWeight:600,fontSize:15,color:"#111" }}>{dark?"Dark Mode":"Light Mode"}</div>
        <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{dark?"Switch to light theme":"Switch to dark theme"}</div>
      </div>
      <Toggle on={dark} onToggle={toggle}/>
    </div>
  );
}

// ── MAIN ACCOUNT SETTINGS PAGE ────────────────────────────────────────────────

function ConnectedAppIcon({ type }) {
  const s = { width:18, height:18, viewBox:"0 0 24 24", fill:"none", stroke:"#fff", strokeWidth:"2" };
  if (type==="apple")  return <svg {...s}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>;
  if (type==="watch")  return <svg {...s}><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="8.56" y1="2" x2="8.56" y2="22"/><line x1="15.44" y1="2" x2="15.44" y2="22"/><line x1="8" y1="12" x2="16" y2="12"/></svg>;
  if (type==="run")    return <svg {...s}><circle cx="12" cy="5" r="2"/><path d="M10 22v-6l-2-3 4-4 2 3h4"/><path d="M10 13l-4 2"/></svg>;
  if (type==="fork")   return <svg {...s}><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function AccountSettingsPage({ onBack }) {
  const { user, profileImg, setProfileImg } = useUser();
  const [apps, setApps]   = useState({ appleHealth:true, fitbit:true, strava:false, myFitnessPal:true });
  const acctScrollRef = useScrollPos("account-settings");
  const [subPage, setSubPage] = useState(null);
  const toggleApp = k => setApps(p=>({...p,[k]:!p[k]}));

  if (subPage==="personal")    return <PersonalDetailsPage      onBack={()=>setSubPage(null)}/>;
  if (subPage==="goal")        return <FitnessGoalPage          onBack={()=>setSubPage(null)}/>;
  if (subPage==="email")       return <ChangeEmailPage          onBack={()=>setSubPage(null)}/>;
  if (subPage==="password")    return <ChangePasswordPage       onBack={()=>setSubPage(null)}/>;
  if (subPage==="payment")     return <PaymentMethodPage        onBack={()=>setSubPage(null)}/>;
  if (subPage==="billing")     return <BillingHistoryPage       onBack={()=>setSubPage(null)}/>;
  if (subPage==="upgrade")     return <UpgradePlanPage          onBack={()=>setSubPage(null)}/>;
  if (subPage==="cancel")      return <CancelSubscriptionPage   onBack={()=>setSubPage(null)}/>;

  const SectionTitle = ({ label }) => (
    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:18,color:"#fff",margin:"24px 0 14px" }}>{label}</div>
  );

  const CONNECTED_APPS = [
    { icon:"apple",   iconBg:"#000",    name:"Apple Health",  k:"appleHealth" },
    { icon:"watch", iconBg:"#00B09B", name:"Fitbit",        k:"fitbit"      },
    { icon:"run",     iconBg:"#FC4C02", name:"Strava",        k:"strava"      },
    { icon:"fork",    iconBg:"#0068FF", name:"MyFitnessPal",  k:"myFitnessPal"},
  ];

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",gap:16,flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>ACCOUNT SETTINGS</div>
      </div>

      <div ref={acctScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 18px 40px" }}>
        {/* Profile hero */}
        <div style={{ display:"flex",alignItems:"center",gap:18,marginBottom:28,paddingTop:4 }}>
          <div style={{ position:"relative",flexShrink:0 }}>
            <div style={{ width:82,height:82,borderRadius:"50%",overflow:"hidden",border:`3px solid ${PRIMARY}` }}>
              {profileImg
                ? <img src={profileImg} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                : <div style={{ width:"100%",height:"100%",background:"#111",display:"flex",alignItems:"center",justifyContent:"center" }}>
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
              }
            </div>
            <label htmlFor="acct-upload" style={{ position:"absolute",top:0,left:0,width:28,height:28,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </label>
            <input id="acct-upload" type="file" accept="image/*" style={{ display:"none" }}
              onChange={e=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>setProfileImg(ev.target.result); r.readAsDataURL(f); }}/>
          </div>
          <div>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",letterSpacing:1,marginBottom:4 }}>{user.name.toUpperCase()}</div>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:PRIMARY,marginBottom:3 }}>Premium Member</div>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Member since April 2024</div>
          </div>
        </div>

        {/* Profile Information */}
        <SectionTitle label="Profile Information"/>
        <div style={{ background:"#fff",borderRadius:20,padding:"0 18px",overflow:"hidden" }}>
          <button onClick={()=>setSubPage("personal")} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,padding:"16px 0",background:"none",border:"none",cursor:"pointer",borderBottom:"1px solid #f0f0f0" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <div style={{ flex:1,fontFamily:FONT,fontWeight:600,fontSize:15,color:"#111",textAlign:"left" }}>Personal Details</div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",padding:"14px 0",borderBottom:"1px solid #f0f0f0" }}>
            {[{lbl:"Age",val:`${user.age} years`},{lbl:"Gender",val:user.gender},{lbl:"Weight",val:`${user.weight} kg`},{lbl:"Height",val:`${user.height} cm`}].map((s,i)=>(
              <div key={i} style={{ padding:"6px 0" }}>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#aaa",marginBottom:3 }}>{s.lbl}</div>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#111" }}>{s.val}</div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:14,padding:"16px 0" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:600,fontSize:15,color:"#111" }}>Fitness Goal</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{user.goal} · Change in Fitness Preferences</div>
            </div>
          </div>
        </div>

        {/* Account Settings */}
        <SectionTitle label="Security"/>
        <div style={{ background:"#fff",borderRadius:20,padding:"0 18px",overflow:"hidden" }}>
          {[
            { label:"Change Email",    ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8l10 7 10-7"/></svg>, page:"email" },
            { label:"Change Password", ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>, page:"password" },
          ].map((r,i,arr)=>(
            <button key={i} onClick={()=>setSubPage(r.page)} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,padding:"15px 0",background:"none",border:"none",cursor:"pointer",borderBottom:"1px solid #f0f0f0",textAlign:"left" }}>
              {r.ico}
              <div style={{ flex:1,fontFamily:FONT,fontWeight:600,fontSize:15,color:"#111" }}>{r.label}</div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          ))}
          {/* Dark / Light Mode */}
          <DarkModeRow/>
        </div>

        {/* Connected Apps */}
        <SectionTitle label="Connected Apps"/>
        <div style={{ background:"#fff",borderRadius:20,padding:"0 18px",overflow:"hidden" }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,padding:"14px 0",borderBottom:"1px solid #f0f0f0" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:600,fontSize:15,color:"#111" }}>App Integrations</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#aaa",marginTop:2 }}>Apple Health, Fitbit, Strava and more</div>
            </div>
            <div style={{ background:"rgba(255,193,7,0.15)",border:"1px solid rgba(255,193,7,0.4)",borderRadius:20,padding:"3px 10px",fontFamily:FONT,fontWeight:700,fontSize:10,color:"#F59E0B",letterSpacing:0.5 }}>SOON</div>
          </div>
          {CONNECTED_APPS.map((app,i)=>(
            <div key={app.k} style={{ display:"flex",alignItems:"center",gap:14,padding:"14px 0",borderBottom:i<CONNECTED_APPS.length-1?"1px solid #f0f0f0":"none",opacity:0.4 }}>
              <div style={{ width:46,height:46,borderRadius:"50%",background:app.iconBg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><ConnectedAppIcon type={app.icon}/></div>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:FONT,fontWeight:600,fontSize:15,color:"#111" }}>{app.name}</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#aaa",marginTop:2 }}>Coming soon</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ddd" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            </div>
          ))}
        </div>

        {/* Subscription & Billing */}
        <SectionTitle label="Subscription & Billing"/>
        <div style={{ background:"#fff",borderRadius:20,padding:"18px",overflow:"hidden" }}>
          <div style={{ background:PRIMARY,borderRadius:14,padding:"14px 18px",display:"flex",alignItems:"center",gap:14,marginBottom:6 }}>
            <div style={{ width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><svg width="18" height="18" viewBox="0 0 24 24" fill="#F59E0B" stroke="#F59E0B" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>
            <div>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff" }}>Premium Plan</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.82)",marginTop:2 }}>$9.83/month · Renews Apr 15, 2027</div>
            </div>
          </div>
          {[
            { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>, label:"Payment Method",     color:"#111",    page:"payment"  },
            { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>, label:"Billing History", color:"#111",    page:"billing"  },
            { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>, label:"Upgrade Plan",     color:PRIMARY,   page:"upgrade"  },
            { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>, label:"Cancel Subscription", color:"#EF4444", page:"cancel" },
          ].map((r,i,arr)=>(
            <button key={i} onClick={()=>setSubPage(r.page)} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,padding:"14px 0",background:"none",border:"none",cursor:"pointer",borderBottom:i<arr.length-1?"1px solid #f0f0f0":"none",textAlign:"left" }}>
              <div style={{ width:28,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{r.ico}</div>
              <div style={{ flex:1,fontFamily:FONT,fontWeight:600,fontSize:15,color:r.color }}>{r.label}</div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={r.color==="111"?"#bbb":r.color} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── FITNESS PREFERENCES ───────────────────────────────────────────────────────
function FitnessPreferencesPage({ onBack }) {
  const fitnessScrollRef = useScrollPos("fitness-prefs");
  const [goal, setGoal] = useState("Muscle Gain");
  const [level, setLevel] = useState("Intermediate");
  const [env, setEnv] = useState("Gym");
  const [days, setDays] = useState(5);
  const [env2, setEnv2] = useState("Full Gym");
  const [equip, setEquip] = useState([]);
  const [saved, setSaved] = useState(false);

  const ChipSel = ({ options, value, onChange }) => (
    <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
      {options.map(o=>(
        <button key={o} onClick={()=>onChange(o)}
          style={{
            padding:"10px 20px",
            borderRadius:50,
            border:`1.5px solid ${value===o?PRIMARY:"#d0d0d0"}`,
            background:value===o?PRIMARY:"#ffffff",
            fontFamily:FONT,
            fontWeight:value===o?700:500,
            fontSize:13,
            color:value===o?"#fff":"#333",
            cursor:"pointer",
            transition:"all 0.2s",
            boxShadow:value===o?"0 2px 12px rgba(0,163,255,0.3)":"none"
          }}>{o}</button>
      ))}
    </div>
  );

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",gap:16,flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>FITNESS PREFERENCES</div>
      </div>
      <div ref={fitnessScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>
        {[
          { label:"PRIMARY GOAL", options:["Build Muscle","Lose Weight","Stay Active","Improve Endurance","Get Toned"], value:goal, onChange:setGoal },
          { label:"EXPERIENCE LEVEL", options:["Beginner","Intermediate","Advanced"], value:level, onChange:setLevel },
          { label:"PREFERRED ENVIRONMENT", options:["Gym","Home","Outdoors","Mix"], value:env, onChange:setEnv },
        ].map((s,i)=>(
          <div key={i} style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:14 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>{s.label}</div>
            <ChipSel options={s.options} value={s.value} onChange={s.onChange}/>
          </div>
        ))}

        {/* Days per week */}
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>DAYS PER WEEK</div>
          <div style={{ display:"flex",gap:10 }}>
            {[2,3,4,5].map(d=>(
              <button key={d} onClick={()=>setDays(d)} style={{ flex:1,padding:"14px 0",borderRadius:14,border:`2px solid ${days===d?PRIMARY:BORDER}`,background:days===d?PRIMARY:"transparent",fontFamily:FONT,fontWeight:600,fontSize:16,color:days===d?"#fff":"#444",cursor:"pointer",transition:"all 0.2s" }}>{d}</button>
            ))}
          </div>
        </div>

        <button onClick={()=>{ setSaved(true); setTimeout(()=>setSaved(false),2000); }} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:saved?"#22C55E":`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",transition:"background 0.3s",boxShadow:`0 4px 20px ${PRIMARY}44` }}>
          {saved?"SAVED!":"SAVE PREFERENCES"}
        </button>
      </div>
    </div>
  );
}

// ── PRIVACY & SECURITY ────────────────────────────────────────────────────────
function PrivacyPage({ onBack }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const [priv, setPriv] = useState({ profilePublic:true, shareStats:false, shareWorkouts:true, analyticsData:true, marketingData:false });
  const privScrollRef = useScrollPos("privacy-page");
  const t = k => setPriv(p=>({...p,[k]:!p[k]}));
  const Row = ({k,lbl,sub}) => (
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:14,borderBottom:`1px solid ${BORDER}`,marginBottom:14 }}>
      <div><div style={{ fontFamily:FONT,fontWeight:600,fontSize:14,color:"#111" }}>{lbl}</div><div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{sub}</div></div>
      <Toggle on={priv[k]} onToggle={()=>t(k)}/>
    </div>
  );
  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",gap:16,flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>PRIVACY & SECURITY</div>
      </div>
      <div ref={privScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:16 }}>PRIVACY</div>
          <Row k="profilePublic"  lbl="Public Profile"     sub="Allow others to view your profile"/>
          <Row k="shareStats"     lbl="Share Stats"        sub="Share your workout stats with friends"/>
          <Row k="shareWorkouts"  lbl="Share Workouts"     sub="Show your workouts in the community feed"/>
          <Row k="analyticsData"  lbl="Analytics Data"     sub="Help us improve VTRX with usage data"/>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div><div style={{ fontFamily:FONT,fontWeight:600,fontSize:14,color:"#111" }}>Marketing Data</div><div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>Personalised offers and recommendations</div></div>
            <Toggle on={priv.marketingData} onToggle={()=>t("marketingData")}/>
          </div>
        </div>
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px" }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:16 }}>ACCOUNT ACTIONS</div>
          {[{lbl:"Download My Data",sub:"Export all your VTRX data",c:"#111"},{lbl:"Delete Account",sub:"Permanently delete your account and data",c:"#EF4444"}].map((r,i)=>(
            <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:i===0?14:0,borderBottom:i===0?`1px solid ${BORDER}`:0,marginBottom:i===0?14:0 }}>
              <div><div style={{ fontFamily:FONT,fontWeight:600,fontSize:14,color:r.c }}>{r.lbl}</div><div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{r.sub}</div></div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={r.c==="#EF4444"?"#EF4444":"#555"} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── SUPPORT ───────────────────────────────────────────────────────────────────
function SupportPage({ onBack }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const [msg, setMsg] = useState(""); const [sent, setSent] = useState(false); const [openFaq, setOpenFaq] = useState(null);
  const suppScrollRef = useScrollPos("support-page");
  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",gap:16,flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>SUPPORT</div>
      </div>
      <div ref={suppScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>
        {/* FAQs */}
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>FREQUENTLY ASKED</div>
          {[
            {q:"How do I reset my password?", a:"Go to the Login screen and tap Forgot Password. Enter your email and we will send you a reset link."},
            {q:"How does the meal swap work?", a:"On the home page, tap Not feeling this? to swap your Meal of the Day. You can swap up to 2 times per day."},
            {q:"How do I log a workout?", a:"Tap the Workouts tab, select your session, and tap Start Workout. Complete your sets and tap the checkmark to finish."},
            {q:"What is Streak Freeze?", a:"Streak Freeze protects your streak if you miss a day. Premium users get 1 freeze per month. Tap the snowflake icon in the top right of your home screen."},
            {q:"How do I upgrade to Premium?", a:"Go to Profile > Account Settings > Upgrade Plan to view plans and start your 1-month free trial."},
            {q:"Can I change my workout preferences?", a:"Yes — go to Profile > Fitness Preferences to update your goals, experience level, equipment and days per week."},
            {q:"How do I cancel my subscription?", a:"Go to Profile > Account Settings > Cancel Subscription. You will keep access until the end of your billing period."},
          ].map((item,i,arr)=>(
            <div key={i} style={{ borderBottom:i<arr.length-1?"1px solid #f0f0f0":"none" }}>
              <button onClick={()=>setOpenFaq(openFaq===i?null:i)}
                style={{ width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 0",background:"none",border:"none",cursor:"pointer",textAlign:"left" }}>
                <span style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#111",flex:1,paddingRight:12 }}>{item.q}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"
                  style={{ flexShrink:0,transform:openFaq===i?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s" }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              {openFaq===i&&(
                <div style={{ fontFamily:FONT,fontSize:13,color:"#555",lineHeight:1.7,paddingBottom:14 }}>{item.a}</div>
              )}
            </div>
          ))}
          </div>
        </div>

        {/* Contact Us */}
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px" }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>CONTACT US</div>
          <textarea value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Describe your issue..." rows={4}
            style={{ width:"100%",background:"#ffffff",border:"1px solid #e0e0e0",borderRadius:12,padding:"12px 14px",fontFamily:FONT,fontSize:13,color:"#111",resize:"none",outline:"none",boxSizing:"border-box" }}/>
          <button onClick={()=>{ if(msg.trim()){ setSent(true); setMsg(""); setTimeout(()=>setSent(false),3000); } }}
            style={{ width:"100%",marginTop:12,padding:"13px 0",borderRadius:50,background:sent?"#22C55E":PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff",letterSpacing:1.5,cursor:"pointer",transition:"background 0.3s" }}>
            {sent?"MESSAGE SENT!":"SEND MESSAGE"}
          </button>
        </div>

    </div>
  );
}

function ProgressPhotosPage({ onBack }) {
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState(0);
  const [compareB, setCompareB] = useState(2);
  const fileInputRef = useRef(null);
  const [activeUpload, setActiveUpload] = useState(null);

  const handleUpload = (e, id) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPhotos(p => p.map(ph => ph.id===id ? {...ph, img:ev.target.result} : ph));
    };
    reader.readAsDataURL(file);
  };

  const addWeek = () => {
    const weekNum = photos.length + 1;
    const date = new Date();
    date.setDate(date.getDate() + (photos.length * 7));
    const label = `Week ${weekNum} — ${date.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`;
    setPhotos(p => [...p, { id:Date.now(), date:label, label:"Add note...", img:null }]);
  };

  if (!isPremium) {
    return (
      <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
        <BackHeader title="PROGRESS PHOTOS" onBack={onBack}/>
        <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32 }}>
          <div style={{ width:80,height:80,borderRadius:"50%",background:"rgba(0,163,255,0.12)",border:"2px solid rgba(0,163,255,0.3)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:24 }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
          </div>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#fff",marginBottom:10,textAlign:"center" }}>Progress Photos</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#888",marginBottom:8,textAlign:"center",lineHeight:1.6 }}>Upload weekly photos and watch your transformation. Side-by-side comparison included.</div>
          <div style={{ fontFamily:FONT,fontSize:12,color:"#555",marginBottom:28,textAlign:"center" }}>Premium feature</div>
          <button onClick={()=>setIsPremium(true)}
            style={{ width:"100%",maxWidth:280,padding:"15px 0",borderRadius:50,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",cursor:"pointer",boxShadow:"0 4px 24px rgba(0,163,255,0.4)" }}>
            Upgrade to Premium
          </button>
          <div style={{ fontFamily:FONT,fontSize:11,color:"#444",marginTop:12 }}>$5.83/month · Cancel anytime</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <BackHeader title="PROGRESS PHOTOS" onBack={onBack}
        right={
          <button onClick={()=>setCompareMode(c=>!c)}
            style={{ padding:"6px 14px",borderRadius:50,background:compareMode?PRIMARY:"rgba(0,163,255,0.1)",border:"1px solid rgba(0,163,255,0.3)",fontFamily:FONT,fontWeight:700,fontSize:11,color:compareMode?"#fff":PRIMARY,cursor:"pointer" }}>
            Compare
          </button>
        }
      />

      <div ref={scrollRef} style={{ flex:1,overflowY:"auto",padding:"16px 16px 40px" }}>

        {/* Compare mode */}
        {compareMode && (
          <div style={{ background:CARD,borderRadius:20,border:"1px solid "+BORDER,padding:16,marginBottom:16 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",marginBottom:12,textAlign:"center" }}>Side-by-Side Comparison</div>
            <div style={{ display:"flex",gap:10,marginBottom:12 }}>
              {[{label:"Before",idx:compareA,set:setCompareA},{label:"After",idx:compareB,set:setCompareB}].map((side,i)=>(
                <div key={i} style={{ flex:1 }}>
                  <div style={{ fontFamily:FONT,fontSize:10,color:"#888",marginBottom:6,textAlign:"center",letterSpacing:1 }}>{side.label.toUpperCase()}</div>
                  <div style={{ height:180,borderRadius:14,overflow:"hidden",background:"#1a1a1a",border:"1px solid "+BORDER,position:"relative" }}>
                    {photos[side.idx] && photos[side.idx].img
                      ? <img src={photos[side.idx].img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                      : <div style={{ height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8 }}>
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#444" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                          <div style={{ fontFamily:FONT,fontSize:10,color:"#444" }}>No photo</div>
                        </div>
                    }
                  </div>
                  {/* Week selector */}
                  <select value={side.idx} onChange={e=>side.set(Number(e.target.value))}
                    style={{ width:"100%",marginTop:8,background:"#1a1a1a",border:"1px solid "+BORDER,borderRadius:10,padding:"6px 10px",fontFamily:FONT,fontSize:10,color:"#888",outline:"none" }}>
                    {photos.map((ph,pi)=>(
                      <option key={pi} value={pi}>{ph.date}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stats bar */}
        <div style={{ display:"flex",gap:10,marginBottom:16 }}>
          {[
            { label:"Weeks Tracked", value:photos.filter(p=>p.img).length, color:PRIMARY },
            { label:"Total Weeks",   value:photos.length,                  color:"#888" },
            { label:"Streak",        value:photos.filter(p=>p.img).length+" wks", color:"#22C55E" },
          ].map((s,i)=>(
            <div key={i} style={{ flex:1,background:CARD,borderRadius:14,border:"1px solid "+BORDER,padding:"12px 8px",textAlign:"center" }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:s.color,marginBottom:3 }}>{s.value}</div>
              <div style={{ fontFamily:FONT,fontSize:10,color:"#555",letterSpacing:0.3 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>

        {/* Photo timeline */}
        <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",marginBottom:12 }}>Weekly Timeline</div>

        {photos.map((photo, i) => (
          <div key={photo.id} style={{ display:"flex",gap:14,marginBottom:16,alignItems:"flex-start" }}>
            {/* Timeline line */}
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",width:28,flexShrink:0 }}>
              <div style={{ width:28,height:28,borderRadius:"50%",background:photo.img?PRIMARY:"rgba(0,163,255,0.1)",border:"2px solid "+(photo.img?PRIMARY:"rgba(0,163,255,0.3)"),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                {photo.img
                  ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                  : <span style={{ fontFamily:FONT,fontWeight:900,fontSize:10,color:PRIMARY }}>{i+1}</span>
                }
              </div>
              {i < photos.length-1 && <div style={{ width:2,height:24,background:"rgba(0,163,255,0.15)",marginTop:4 }}/>}
            </div>

            {/* Photo card */}
            <div style={{ flex:1,background:CARD,borderRadius:16,border:"1px solid "+BORDER,overflow:"hidden" }}>
              {/* Photo area */}
              <input type="file" accept="image/*" ref={i===activeUpload?fileInputRef:null}
                style={{ display:"none" }} onChange={e=>handleUpload(e,photo.id)}/>
              <div onClick={()=>{ setActiveUpload(i); setTimeout(()=>{ if(fileInputRef.current) fileInputRef.current.click(); },50); }}
                style={{ height:180,background:"#1a1a1a",cursor:"pointer",position:"relative",display:"flex",alignItems:"center",justifyContent:"center" }}>
                {photo.img
                  ? <>
                      <img src={photo.img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover",position:"absolute",inset:0 }}/>
                      <div style={{ position:"absolute",bottom:8,right:8,background:"rgba(0,0,0,0.6)",borderRadius:8,padding:"4px 10px" }}>
                        <span style={{ fontFamily:FONT,fontSize:10,color:"#fff",fontWeight:600 }}>Change</span>
                      </div>
                    </>
                  : <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:10 }}>
                      <div style={{ width:52,height:52,borderRadius:"50%",background:"rgba(0,163,255,0.1)",border:"1.5px dashed rgba(0,163,255,0.4)",display:"flex",alignItems:"center",justifyContent:"center" }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                      </div>
                      <div style={{ fontFamily:FONT,fontSize:12,color:"#888",textAlign:"center",lineHeight:1.4 }}>Tap to upload<br/>your photo</div>
                    </div>
                }
              </div>

              {/* Info */}
              <div style={{ padding:"12px 14px" }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",marginBottom:2 }}>{photo.date}</div>
                <div style={{ fontFamily:FONT,fontSize:11,color:"#666" }}>{photo.label}</div>
              </div>
            </div>
          </div>
        ))}

        {/* Add week button */}
        <button onClick={addWeek}
          style={{ width:"100%",padding:"14px 0",borderRadius:50,background:"transparent",border:"1.5px dashed rgba(0,163,255,0.3)",fontFamily:FONT,fontWeight:700,fontSize:13,color:PRIMARY,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginTop:4 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Next Week
        </button>

      </div>
    </div>
  );
}

function ProfilePage({ onBack, onLogout }) {
  const profileScrollRef = useScrollPos("profile-page");
  const [showLogout, setShowLogout] = useState(false);
  const { user, profileImg, setProfileImg } = useUser();
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const [subPage, setSubPage] = useState(null);
  const profScrollRef = useRef(null);
  const savedPos = useRef(0);

  // Save position before navigating to sub-page, restore when coming back
  const goToSubPage = (page) => {
    if (profScrollRef.current) savedPos.current = profScrollRef.current.scrollTop;
    setSubPage(page);
  };
  const goBackFromSubPage = () => {
    setSubPage(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (profScrollRef.current) profScrollRef.current.scrollTop = savedPos.current;
      });
    });
  };

  if (subPage==="progress")    return <ProgressPhotosPage     onBack={goBackFromSubPage}/>;
  if (subPage==="account")     return <AccountSettingsPage    onBack={goBackFromSubPage}/>;
  if (subPage==="fitness")     return <FitnessPreferencesPage onBack={goBackFromSubPage}/>;
  if (subPage==="notifSettings")return <NotifSettingsPage     onBack={goBackFromSubPage}/>;
  if (subPage==="privacy")     return <PrivacyPage            onBack={goBackFromSubPage}/>;
  if (subPage==="support")     return <SupportPage            onBack={goBackFromSubPage}/>;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      {/* Header */}
      <div style={{ padding:"50px 18px 14px",display:"flex",alignItems:"center",gap:16,flexShrink:0,background:BG }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={"#888888"} strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:PRIMARY,letterSpacing:2 }}>PROFILE SETTINGS</div>
      </div>

      <div ref={profScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 100px",background:BG }}>
        {/* Avatar + name */}
        <div style={{ display:"flex",flexDirection:"column",alignItems:"center",marginBottom:32,paddingTop:8 }}>
          <div style={{ position:"relative",marginBottom:14 }}>
            <div style={{ width:96,height:96,borderRadius:"50%",border:`3px solid ${PRIMARY}`,overflow:"hidden",boxShadow:`0 0 24px ${PRIMARY}44` }}>
              {profileImg
                ? <img src={profileImg} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                : <div style={{ width:"100%",height:"100%",background:"#111",display:"flex",alignItems:"center",justifyContent:"center" }}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
              }
            </div>
            {/* Edit badge — taps hidden file input */}
            <label htmlFor="profile-upload" style={{ position:"absolute",bottom:0,right:0,width:28,height:28,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center",border:"2px solid #0a0a0a",cursor:"pointer" }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </label>
            <input id="profile-upload" type="file" accept="image/*" style={{ display:"none" }}
              onChange={e=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>setProfileImg(ev.target.result); r.readAsDataURL(f); }}/>
          </div>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#ffffff",marginBottom:4,textAlign:"center" }}>{user.name}</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",textAlign:"center" }}>Fitness Goal: {user.goal}</div>

          {/* Achievements strip */}
          <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 14px 12px",marginTop:20,width:"100%" }}>
            {/* Achievement badges row */}
            <div style={{ display:"flex",justifyContent:"space-around",marginBottom:12 }}>
              {[
                { earned:true,  bg:"#CA8A04", icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>,  label:"First Win"     },
                { earned:true,  bg:"#EF4444", icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 2c0 6-6 8-6 14a6 6 0 0012 0c0-6-6-8-6-14z"/><path d="M12 12c0 3-2 4-2 6a2 2 0 004 0c0-2-2-3-2-6z" fill="rgba(255,255,255,0.5)"/></svg>, label:"7-Day Streak"  },
                { earned:true,  bg:"#374151", icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><text x="12" y="16" textAnchor="middle" fill="white" fontSize="9" fontWeight="bold" stroke="none">30</text></svg>, label:"30-Day"       },
                { earned:true,  bg:"#D97706", icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>, label:"Team Player"  },
                { earned:false, bg:"#6D28D9", icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2" stroke="rgba(255,255,255,0.6)" strokeWidth="2" fill="none"/><text x="12" y="16" textAnchor="middle" fill="white" fontSize="9" fontWeight="bold" stroke="none">$</text></svg>, label:"$50 Won"       },
              ].map((a,i)=>(
                <div key={i} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:6 }}>
                  <div style={{ width:48,height:48,borderRadius:"50%",background:a.earned?a.bg:"#1a1a1a",border:a.earned?"none":`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",opacity:a.earned?1:0.4,boxShadow:a.earned?`0 2px 12px ${a.bg}66`:"none" }}>
                    {a.icon}
                  </div>
                  <div style={{ fontFamily:FONT,fontSize:10,color:a.earned?"#aaa":"#444",textAlign:"center",letterSpacing:0.3,maxWidth:44,lineHeight:1.2 }}>{a.label}</div>
                </div>
              ))}
            </div>
            {/* Total points */}
            <div style={{ textAlign:"center",paddingTop:10,borderTop:`1px solid ${BORDER}` }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:PRIMARY }}>Total Points: </span>
              <span style={{ fontFamily:FONT,fontWeight:900,fontSize:14,color:PRIMARY }}>3,450</span>
            </div>
          </div>
        </div>

        {/* Menu rows */}
        <ProfileRow label="Account Settings"     sub="Manage your profile and preferences"     onPress={()=>setSubPage("account")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>}/>
        <ProfileRow label="My Challenges"
          sub="Coming soon — challenge mode launches next update"
          onPress={null}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>}
          right={<div style={{ background:"rgba(255,193,7,0.15)",border:"1px solid rgba(255,193,7,0.4)",borderRadius:20,padding:"3px 10px",fontFamily:FONT,fontWeight:700,fontSize:10,color:"#F59E0B",letterSpacing:0.5 }}>SOON</div>}
        />
        <ProfileRow label="Fitness Preferences"  sub="Workout intensity and training goals"       onPress={()=>setSubPage("fitness")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></svg>}/>
        <ProfileRow label="Notifications"        sub="Workout reminders and achievements"         onPress={()=>setSubPage("notifSettings")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>}/>
        <ProfileRow label="Privacy & Security"   sub="Data protection and account security"      onPress={()=>setSubPage("privacy")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}/>
        <ProfileRow label="Support"              sub="Help center and contact support"            onPress={()=>setSubPage("support")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><circle cx="12" cy="12" r="10"/>

        {showLogout && (
          <div onClick={()=>setShowLogout(false)} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:200,display:"flex",alignItems:"flex-end" }}>
            <div onClick={e=>e.stopPropagation()} style={{ width:"100%",background:CARD,borderRadius:"24px 24px 0 0",padding:"28px 24px 40px",border:`1px solid ${BORDER}` }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:18,color:"#fff",textAlign:"center",marginBottom:8 }}>Log Out?</div>
              <div style={{ fontFamily:FONT,fontSize:13,color:"#888",textAlign:"center",marginBottom:24 }}>You will need to log back in to access your account.</div>
              <button onClick={()=>{ setShowLogout(false); onLogout&&onLogout(); }} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:"#EF4444",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",marginBottom:12 }}>YES, LOG OUT</button>
              <button onClick={()=>setShowLogout(false)} style={{ width:"100%",padding:"13px 0",borderRadius:50,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:14,color:"#888",cursor:"pointer" }}>CANCEL</button>
            </div>
          </div>
        )}

        <button onClick={()=>setShowLogout(true)} style={{ width:"100%",padding:"16px 0",borderRadius:18,background:"#7C2D12",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginTop:8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          LOGOUT
        </button><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}/>

      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// ── NUTRITION HUB ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
const MEAL_PLAN = [
  { time:"Breakfast", name:"Greek Yogurt Protein Bowl",  cal:320, protein:28, prep:"5 min",  img:"https://images.unsplash.com/photo-1488477181946-6428a0291777?w=200&q=80" },
  { time:"Lunch",     name:"Grilled Chicken Power Bowl", cal:485, protein:42, prep:"20 min", img:"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=200&q=80" },
  { time:"Snack",     name:"Protein Smoothie Bowl",      cal:340, protein:30, prep:"5 min",  img:"https://images.unsplash.com/photo-1547592180-85f173990554?w=200&q=80" },
  { time:"Dinner",    name:"Grilled Salmon Bowl",        cal:435, protein:38, prep:"25 min", img:"https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=200&q=80" },
];

const GROCERY_LIST = [
  { category:"Proteins", items:[
    { name:"Chicken Breast",   qty:"500g"    },
    { name:"Salmon Fillets",   qty:"2 pieces"},
    { name:"Greek Yogurt",     qty:"500ml"   },
    { name:"Eggs",             qty:"12 pack" },
    { name:"Tuna (canned)",    qty:"3 tins"  },
  ]},
  { category:"Carbs & Grains", items:[
    { name:"Brown Rice",       qty:"1kg"     },
    { name:"Rolled Oats",      qty:"500g"    },
    { name:"Sweet Potato",     qty:"3 medium"},
    { name:"Wholegrain Bread", qty:"1 loaf"  },
  ]},
  { category:"Vegetables", items:[
    { name:"Broccoli",         qty:"1 head"  },
    { name:"Spinach",          qty:"200g bag"},
    { name:"Avocado",          qty:"3 pieces"},
    { name:"Cherry Tomatoes",  qty:"250g"    },
  ]},
  { category:"Extras", items:[
    { name:"Olive Oil",        qty:"500ml"   },
    { name:"Protein Powder",   qty:"1 tub"   },
    { name:"Almonds",          qty:"200g"    },
  ]},
];

function NutritionHub({ onBack, energyKey, onLogout }) {
  const { isPremium, setIsPremium } = useUser();
  const [showProfile, setShowProfile] = useState(false);
  const [subTab, setSubTab]           = useState(0); // 0=Discover 1=Plan 2=Grocery 3=Saved
  const [filter, setFilter]           = useState("All");
  const scrollRef = useScrollPos("nutrition-" + subTab);
  const [search, setSearch]           = useState("");
  const [savedIds, setSavedIds]       = useState([0,3,7]);
  const [selectedRecipe, setSelectedRecipe] = useState(null);
  const [saveMsg, setSaveMsg]         = useState("");
  const [swapTarget, setSwapTarget]   = useState(null);

  const toggleSave = (id) => {
    if (!isPremium && !savedIds.includes(id) && savedIds.length >= 3) {
      setSaveMsg("Free plan: 3 saved recipes max. Upgrade for unlimited saves.");
      setTimeout(()=>setSaveMsg(""), 3000);
      return;
    }
    setSavedIds(p => p.includes(id) ? p.filter(x=>x!==id) : [...p,id]);
  };

  const aiSug = AI_SUGGESTIONS[energyKey] || AI_SUGGESTIONS.okay;

  const [trialEndedDismissed, setTrialEndedDismissed] = useState(false);
  const showTrialBanner = !isPremium && !trialEndedDismissed;

  if (showProfile) return <ProfilePage onBack={()=>setShowProfile(false)} onLogout={()=>{ setShowProfile(false); onLogout&&onLogout(); }}/>;
  if (selectedRecipe !== null) return <RecipeFullPage r={RECIPES[selectedRecipe]} onBack={()=>setSelectedRecipe(null)} saved={savedIds.includes(selectedRecipe)} onToggleSave={()=>toggleSave(selectedRecipe)}/>;

  const filtered = RECIPES.filter(r=>{
    const matchCat = filter==="All" || r.tags?.includes(filter);
    const matchSearch = search==="" || r.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const TABS=[{label:"Discover",icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>},{label:"Plan",icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>},{label:"Grocery",icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>},{label:"Saved",icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>}];

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      {saveMsg&&<div style={{ position:"absolute",bottom:80,left:16,right:16,zIndex:200,background:"#1a1a1a",border:"1px solid rgba(0,163,255,0.3)",borderRadius:14,padding:"12px 16px",fontFamily:FONT,fontSize:13,color:"#fff",textAlign:"center",boxShadow:"0 4px 24px rgba(0,0,0,0.4)" }}>{saveMsg}</div>}
      {/* Header */}
      <div style={{ padding:"52px 16px 12px",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:44,height:44,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>
          </div>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",letterSpacing:2 }}>NUTRITION</div>
        </div>
        <button onClick={()=>setShowProfile(true)} style={{ width:40,height:40,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </button>
      </div>
      {/* Sub tabs */}
      <div style={{ display:"flex",padding:"0 16px 12px",gap:8 }}>
        {TABS.map((t,i)=>(
          <button key={i} onClick={()=>setSubTab(i)}
            style={{ flex:1,padding:"8px 4px",borderRadius:12,border:`1.5px solid ${subTab===i?PRIMARY:BORDER}`,background:subTab===i?`${PRIMARY}18`:"transparent",display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer",transition:"all 0.2s" }}>
            <span style={{ color:subTab===i?PRIMARY:"#555",display:"flex" }}>{t.icon}</span>
            <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:subTab===i?PRIMARY:"#555",letterSpacing:0.3 }}>{t.label}</span>
            {(i===1||i===2)&&!isPremium&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>}
          </button>
        ))}
      </div>

      <div ref={scrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 80px" }}>
        {subTab===0 && (
          <div>
            {/* AI suggestion banner */}
            <div style={{ background:`${PRIMARY}12`,border:`1px solid ${PRIMARY}30`,borderRadius:16,padding:"14px 16px",marginBottom:14 }}>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
                <span style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff" }}>{isPremium ? aiSug.title : isPremium ? aiSug.title : "AI Coach — 1 Free Summary This Week"}</span>
              </div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#aaa",lineHeight:1.55,marginBottom:10 }}>
                {isPremium
                  ? aiSug.tip
                  : "You get 1 basic AI summary per week on the free plan. Start your free trial for full AI coaching after every session."}
              </div>
              {!isPremium && (
                <button onClick={()=>{}} style={{ background:"none",border:`1px solid ${PRIMARY}`,borderRadius:50,padding:"8px 18px",fontFamily:FONT,fontWeight:700,fontSize:12,color:PRIMARY,cursor:"pointer",letterSpacing:0.5,marginBottom:8 }}>
                  START FREE TRIAL →
                </button>
              )}
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                {isPremium && aiSug.rec.map(ri=>(
                  <div key={ri} onClick={()=>setSelectedRecipe(ri)}
                    style={{ display:"flex",alignItems:"center",gap:12,borderRadius:14,overflow:"hidden",cursor:"pointer",background:"#ffffff",border:"1px solid #e8e8e8",padding:"8px 10px 8px 8px" }}>
                    <div style={{ width:56,height:56,borderRadius:10,overflow:"hidden",flexShrink:0 }}><img src={RECIPES[ri].img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/></div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:FONT,fontSize:13,fontWeight:700,color:"#111",lineHeight:1.3,marginBottom:3 }}>{RECIPES[ri].name}</div>
                      <div style={{ display:"flex",gap:8,alignItems:"center" }}><span style={{ fontFamily:FONT,fontSize:12,color:"#EF4444",fontWeight:600 }}>{RECIPES[ri].cal} cal</span><span style={{ fontFamily:FONT,fontSize:12,color:PRIMARY,fontWeight:600 }}>{RECIPES[ri].protein}g protein</span></div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                  </div>
                ))}
              </div>
            </div>
            {/* Search */}
            <div style={{ position:"relative",marginBottom:12 }}>
              <svg style={{ position:"absolute",left:12,top:"50%",transform:"translateY(-50%)" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search recipes..." style={{ width:"100%",background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"10px 12px 10px 36px",fontFamily:FONT,fontSize:13,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
            </div>
            {/* Filters */}
            <div style={{ display:"flex",gap:8,overflowX:"auto",marginBottom:14,paddingBottom:4 }}>
              {NUTRITION_FILTERS.map(f=>(
                <button key={f} onClick={()=>setFilter(f)}
                  style={{ flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${filter===f?PRIMARY:BORDER}`,background:filter===f?`${PRIMARY}18`:"transparent",fontFamily:FONT,fontWeight:600,fontSize:11,color:filter===f?PRIMARY:"#666",cursor:"pointer",transition:"all 0.2s" }}>
                  {f}
                </button>
              ))}
            </div>
            {/* Recipe grid */}
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
              {filtered.map((r,i)=>(
                <div key={i} onClick={()=>setSelectedRecipe(RECIPES.indexOf(r))} style={{ background:CARD,borderRadius:14,overflow:"hidden",cursor:"pointer",border:`1px solid ${BORDER}` }}>
                  <div style={{ height:110,overflow:"hidden",position:"relative" }}>
                    <img src={r.img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                    <button onClick={e=>{ e.stopPropagation(); toggleSave(RECIPES.indexOf(r)); }} style={{ position:"absolute",top:8,right:8,width:28,height:28,borderRadius:"50%",background:"rgba(0,0,0,0.5)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill={savedIds.includes(RECIPES.indexOf(r))?"#00A3FF":"none"} stroke="#fff" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
                    </button>
                  </div>
                  <div style={{ padding:"10px" }}>
                    <div style={{ fontFamily:FONT,fontSize:12,fontWeight:700,color:"#fff",marginBottom:4,lineHeight:1.3 }}>{r.name}</div>
                    <div style={{ display:"flex",gap:6 }}>
                      <span style={{ fontFamily:FONT,fontSize:10,color:"#EF4444",fontWeight:600 }}>{r.cal} cal</span>
                      <span style={{ fontFamily:FONT,fontSize:10,color:PRIMARY,fontWeight:600 }}>{r.protein}g protein</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {subTab===1 && (
          isPremium ? (
            <div>
              {/* Weekly calendar */}
              <div style={{ display:"flex",gap:6,marginBottom:16,overflowX:"auto" }}>
                {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d,i)=>(
                  <div key={i} style={{ flexShrink:0,width:44,textAlign:"center",padding:"8px 4px",borderRadius:12,background:i===1?PRIMARY:CARD,border:`1px solid ${i===1?PRIMARY:BORDER}` }}>
                    <div style={{ fontFamily:FONT,fontSize:10,fontWeight:700,color:i===1?"#fff":"#888",marginBottom:4 }}>{d}</div>
                    <div style={{ fontFamily:FONT,fontSize:13,fontWeight:800,color:i===1?"#fff":"#fff" }}>{i+14}</div>
                  </div>
                ))}
              </div>
              {/* Daily totals */}
              <div style={{ background:CARD,borderRadius:14,padding:"14px 16px",marginBottom:14,border:`1px solid ${BORDER}`,display:"flex",justifyContent:"space-around" }}>
                {[{l:"Calories",v:"1,840",c:"#EF4444"},{l:"Protein",v:"142g",c:PRIMARY},{l:"Carbs",v:"198g",c:"#F97316"},{l:"Fat",v:"58g",c:"#A78BFA"}].map((item,i)=>(
                  <div key={i} style={{ textAlign:"center" }}>
                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:item.c }}>{item.v}</div>
                    <div style={{ fontFamily:FONT,fontSize:10,color:"#888" }}>{item.l}</div>
                  </div>
                ))}
              </div>
              {/* Meal cards */}
              {MEAL_PLAN.map((meal,i)=>(
                <div key={i} style={{ background:"#ffffff",borderRadius:16,padding:"14px",marginBottom:12 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888",marginBottom:6 }}>{meal.time}</div>
                  <div style={{ display:"flex",gap:10,alignItems:"center" }}>
                    <img src={meal.img} alt="" style={{ width:56,height:56,borderRadius:10,objectFit:"cover",flexShrink:0 }}/>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#111" }}>{meal.name}</div>
                      <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:2 }}>{meal.cal} cal · {meal.protein}g protein</div>
                      <div style={{ fontFamily:FONT,fontSize:11,color:"#aaa",marginTop:2 }}>{meal.prep} prep</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : <PremiumGate feature="Meal Plan" onUpgrade={()=>setIsPremium(true)}/>
        )}

        {subTab===2 && (
          isPremium ? (
            <div>
              {GROCERY_LIST.map((cat,i)=>(
                <div key={i} style={{ background:"#ffffff",borderRadius:16,padding:"14px 16px",marginBottom:12 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888",letterSpacing:1,marginBottom:10 }}>{cat.category.toUpperCase()}</div>
                  {cat.items.map((item,j)=>(
                    <div key={j} style={{ display:"flex",alignItems:"center",gap:12,paddingBottom:j<cat.items.length-1?10:0,marginBottom:j<cat.items.length-1?10:0,borderBottom:j<cat.items.length-1?"1px solid #f0f0f0":"none" }}>
                      <div style={{ width:26,height:26,borderRadius:6,border:"2px solid #e0e0e0",background:"#f9f9f9",flexShrink:0 }}/>
                      <div style={{ flex:1 }}>
                        <div style={{ fontFamily:FONT,fontWeight:600,fontSize:15,color:"#111" }}>{item.name}</div>
                        <div style={{ fontFamily:FONT,fontSize:12,color:"#888" }}>{item.qty}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : <PremiumGate feature="Grocery List" onUpgrade={()=>setIsPremium(true)}/>
        )}

        {subTab===3 && (
          <div>
            {savedIds.length===0 ? (
              <div style={{ textAlign:"center",padding:"60px 20px",color:"#555",fontFamily:FONT,fontSize:14 }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5" style={{marginBottom:16,display:"block",margin:"0 auto 16px"}}><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
                No saved recipes yet. Tap the bookmark icon on any recipe.
              </div>
            ) : savedIds.map(id=>(
              <div key={id} onClick={()=>setSelectedRecipe(id)} style={{ background:CARD,borderRadius:14,padding:"12px",marginBottom:10,display:"flex",gap:12,alignItems:"center",border:`1px solid ${BORDER}`,cursor:"pointer" }}>
                <img src={RECIPES[id].img} alt="" style={{ width:60,height:60,borderRadius:10,objectFit:"cover",flexShrink:0 }}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",marginBottom:3 }}>{RECIPES[id].name}</div>
                  <div style={{ display:"flex",gap:8 }}>
                    <span style={{ fontFamily:FONT,fontSize:11,color:"#EF4444",fontWeight:600 }}>{RECIPES[id].cal} cal</span>
                    <span style={{ fontFamily:FONT,fontSize:11,color:PRIMARY,fontWeight:600 }}>{RECIPES[id].protein}g protein</span>
                  </div>
                </div>
                <button onClick={e=>{ e.stopPropagation(); toggleSave(id); }} style={{ width:32,height:32,borderRadius:"50%",background:"rgba(0,163,255,0.1)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={PRIMARY} stroke={PRIMARY} strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
                </button>
              </div>
            ))}
            {!isPremium&&savedIds.length>=3&&<div style={{ textAlign:"center",padding:"16px",fontFamily:FONT,fontSize:12,color:"#666" }}>Upgrade to Premium for unlimited saves</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── DASHBOARD HELPERS ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function Ring({ pct }) {
  const r=36,c=2*Math.PI*r,offset=c*(1-pct/100);
  return <svg width="88" height="88" viewBox="0 0 88 88"><circle cx="44" cy="44" r={r} fill="none" stroke="#1a1a1a" strokeWidth="8"/><circle cx="44" cy="44" r={r} fill="none" stroke={PRIMARY} strokeWidth="8" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset} transform="rotate(-90 44 44)"/></svg>;
}

function useTypewriter(text, active) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  useEffect(()=>{
    if (!active) { setDisplayed(""); setDone(false); return; }
    let i=0; setDisplayed(""); setDone(false);
    const iv=setInterval(()=>{ i++; setDisplayed(text.slice(0,i)); if(i>=text.length){ clearInterval(iv); setDone(true); } },18);
    return ()=>clearInterval(iv);
  },[text,active]);
  return {displayed,done};
}

const AI_TEXT = {empty:"Your body needed rest today — and that's wisdom, not weakness. Recovery sessions reduce cortisol by up to 26% and accelerate muscle repair.",low:"Light cardio completed. You burned 150 calories and kept your cardiovascular system active on a tough day.",okay:"Solid chest and triceps session. Your pushing muscles are showing clear progressive strength gains. VTRX recommends adding 2.5kg to your bench press next session.",good:"Outstanding full-body session. Your output today was 22% above your weekly average. You're ready to advance your squat weight next week.",peak:"MAX EFFORT achieved. Today's session ranks in your top 10% of all-time performance. Eat your post-workout meal within 45 minutes."};

function StatIcon({ type, color }) {
  const s = { width:13, height:13, viewBox:"0 0 24 24", fill:"none", stroke:color||"currentColor", strokeWidth:"2.5" };
  if (type==="clock")   return <svg {...s}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
  if (type==="fire")    return <svg {...s} stroke="none" fill={color||"currentColor"}><path d="M12 2c0 6-6 8-6 14a6 6 0 0012 0c0-6-6-8-6-14z"/></svg>;
  if (type==="bolt")    return <svg {...s} stroke="none" fill={color||"currentColor"}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── DASHBOARD ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// ── Trial Ended Banner ────────────────────────────────────────────────────────
function TrialEndedBanner({ onUpgrade }) {
  const [show, setShow] = useState(true);
  if (!show) return null;
  return (
    <div style={{ position:"fixed",bottom:80,left:16,right:16,zIndex:200,
      background:"linear-gradient(135deg,#0A1628 0%,#0d1f3c 100%)",
      border:"1px solid #00A3FF",borderRadius:20,padding:"16px 18px",
      boxShadow:"0 8px 40px rgba(0,163,255,0.2)" }}>
      <div style={{ display:"flex",alignItems:"flex-start",gap:12 }}>
        <div style={{ width:36,height:36,borderRadius:10,background:"rgba(0,163,255,0.15)",
          border:"1px solid rgba(0,163,255,0.3)",display:"flex",alignItems:"center",
          justifyContent:"center",flexShrink:0 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
          </svg>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:"Montserrat,sans-serif",fontWeight:800,fontSize:14,color:"#fff",marginBottom:4 }}>
            Your free trial has ended
          </div>
          <div style={{ fontFamily:"Montserrat,sans-serif",fontSize:12,color:"#888",lineHeight:1.5,marginBottom:10 }}>
            You had AI coaching after every workout, full meal planning, and complete history. Keep all of it for $9.99/month.
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={onUpgrade}
              style={{ flex:1,padding:"9px 0",borderRadius:50,background:"#00A3FF",border:"none",
                fontFamily:"Montserrat,sans-serif",fontWeight:800,fontSize:12,color:"#fff",cursor:"pointer",letterSpacing:0.5 }}>
              KEEP PREMIUM — $9.99/MO
            </button>
            <button onClick={()=>setShow(false)}
              style={{ padding:"9px 14px",borderRadius:50,background:"transparent",
                border:"1px solid #333",fontFamily:"Montserrat,sans-serif",fontSize:12,color:"#666",cursor:"pointer" }}>
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ userProfile, onNavigate, scrollRef, mealIdx=0, setMealIdx, streakDay=1, energyKey, onMoodSelect }) {
  const { dark, toggle: toggleTheme } = useTheme();
  const { user, profileImg } = useUser();
  const [showSwap, setShowSwap] = useState(false);
  const [swapCount, setSwapCount] = useState(0);
  const MAX_SWAPS = 2;
const MAX_FREE_AI   = 1;  // free users get 1 basic AI summary per week
const FREE_HISTORY_DAYS = 14; // free users see last 14 days only
  const [waterGlasses, setWaterGlasses] = useState(3);
  const WATER_GOAL = 8;
  const [showMood, setShowMood]         = useState(true);
  const [showFreezeTooltip, setShowFreezeTooltip] = useState(true);
  const [notifCount]                    = useState(2);
  const workout = WEEKLY_WORKOUTS[TODAY_IDX % WEEKLY_WORKOUTS.length];
  const meal = MEALS[mealIdx % MEALS.length];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = (user?.name || "Nhamo M").split(" ")[0];

  const MOOD_DATA = [
    { key:"empty",  faceType:"empty",  label:"Rest Day",      sub:"Low energy — take it easy",        color:"#6B7280", bg:"rgba(107,114,128,0.1)" },
    { key:"low",    faceType:"low",    label:"Not Feeling It", sub:"Some movement is better than none", color:"#EF4444", bg:"rgba(239,68,68,0.1)"   },
    { key:"okay",   faceType:"okay",   label:"Pretty Good",    sub:"Moderate session recommended",      color:"#F97316", bg:"rgba(249,115,22,0.1)"  },
    { key:"good",   faceType:"good",   label:"Feeling Strong", sub:"Push a bit harder today",           color:"#22C55E", bg:"rgba(34,197,94,0.1)"   },
    { key:"peak",   faceType:"peak",   label:"Let's Go Hard",  sub:"Maximum effort — this is your day", color:PRIMARY,   bg:"rgba(0,163,255,0.1)"   },
  ];

  return (
    <div ref={scrollRef} style={{ flex:1,overflowY:"auto",padding:"0 0 90px" }}>
      {showTrialBanner && <TrialEndedBanner onUpgrade={()=>setTrialEndedDismissed(true)}/>}
      {/* Header */}
      <div style={{ padding:"52px 16px 10px",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
        <div>
          <div style={{ fontFamily:FONT,fontSize:12,color:"#666",marginBottom:2 }}>{new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}</div>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:22,color:"#fff" }}>{greeting}, {firstName}</div>
          <div style={{ display:"flex",alignItems:"center",gap:6,marginTop:6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#F97316" stroke="none"><path d="M12 2c0 6-6 8-6 14a6 6 0 0012 0c0-6-6-8-6-14z"/></svg>
            <span style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:"#F97316" }}>{streakDay} day streak</span>
            <span onClick={()=>onNavigate("fitnessStats")} style={{ fontFamily:FONT,fontSize:11,color:"#555",marginLeft:4,cursor:"pointer",textDecoration:"underline" }}>View stats</span>
          </div>
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          {/* Streak freeze */}
          <div style={{ position:"relative" }}>
            <button onClick={()=>setShowFreezeTooltip(false)} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" strokeWidth="2"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            </button>
            {showFreezeTooltip&&<div style={{ position:"absolute",right:0,top:44,background:"#1a1a1a",border:`1px solid ${BORDER}`,borderRadius:12,padding:"8px 12px",width:160,zIndex:100 }}><div style={{ fontFamily:FONT,fontSize:11,color:"#fff",fontWeight:700,marginBottom:2 }}>Streak Freeze</div><div style={{ fontFamily:FONT,fontSize:10,color:"#888",lineHeight:1.4 }}>Protects your streak if you miss a day. Tap to dismiss.</div></div>}
          </div>
          {/* Notif */}
          <div style={{ position:"relative" }}>
            <button onClick={()=>onNavigate("notifications")} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
            </button>
            {notifCount>0&&<div style={{ position:"absolute",top:-2,right:-2,width:16,height:16,borderRadius:"50%",background:"#EF4444",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:FONT,fontWeight:800,fontSize:10,color:"#fff" }}>{notifCount}</div>}
          </div>
        </div>
      </div>

      <div style={{ padding:"0 16px" }}>
        {/* Mood check-in */}
        {showMood&&!energyKey&&(
          <div style={{ background:CARD,borderRadius:20,padding:"16px",marginBottom:14,border:`1px solid ${BORDER}` }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",marginBottom:12 }}>How are you feeling today?</div>
            <div style={{ display:"flex",gap:8 }}>
              {MOOD_DATA.map(m=>(
                <button key={m.key} onClick={async ()=>{
            onMoodSelect&&onMoodSelect(m.key);
            setShowMood(false);
            // Log mood regardless — AI response only for Premium/trial users
            apiCall("/users/mood", { method:"POST", body:JSON.stringify({ mood:m.key }) }).catch(()=>{});
          }}
                  style={{ flex:1,padding:"8px 4px",borderRadius:14,border:`1.5px solid ${BORDER}`,background:"transparent",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4 }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={m.color} strokeWidth="1.8">
                    <circle cx="12" cy="12" r="10"/>
                    {m.key==="peak"&&<><path d="M8 13s1.5 3 4 3 4-3 4-3"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></>}
                    {m.key==="good"&&<><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></>}
                    {m.key==="okay"&&<><line x1="8" y1="14" x2="16" y2="14"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></>}
                    {m.key==="low"&&<><path d="M16 14s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></>}
                    {m.key==="empty"&&<><path d="M16 16s-1.5-3-4-3-4 3-4 3"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></>}
                  </svg>
                  <span style={{ fontFamily:FONT,fontSize:10,fontWeight:600,color:m.color }}>{m.label.split(" ")[0]}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Today's Workout */}
        <div onClick={()=>onNavigate("workoutDetail")} style={{ background:CARD,borderRadius:20,padding:"16px",marginBottom:14,border:`1px solid ${BORDER}`,cursor:"pointer" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12 }}>
            <div>
              <div style={{ fontFamily:FONT,fontSize:11,color:"#666",fontWeight:600,marginBottom:2 }}>TODAY'S WORKOUT</div>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff" }}>{workout.name}</div>
            </div>
            <div style={{ background:PRIMARY,borderRadius:20,padding:"4px 10px" }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#fff",letterSpacing:0.5 }}>{workout.type}</span>
            </div>
          </div>
          <div style={{ display:"flex",gap:8 }}>
            {[{val:workout.duration,ico:"clock",col:"#EF4444"},{val:workout.cal,ico:"fire",col:"#FF6B35"},{val:workout.exercises?.length||3,ico:"bolt",col:PRIMARY}].map((s,i)=>(
              <div key={i} style={{ display:"flex",alignItems:"center",gap:6,background:`${s.col}15`,border:`1px solid ${s.col}55`,borderRadius:20,padding:"6px 12px" }}>
                <StatIcon type={s.ico} color={s.col}/>
                <span style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:s.col }}>{s.val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Meal of the Day */}
        <div style={{ background:CARD,borderRadius:20,padding:"16px",marginBottom:14,border:`1px solid ${BORDER}` }}>
          <div style={{ fontFamily:FONT,fontSize:11,color:"#666",fontWeight:600,marginBottom:8 }}>MEAL OF THE DAY</div>
          <div style={{ display:"flex",gap:13,marginBottom:15 }}>
            <div style={{ width:88,height:88,borderRadius:14,overflow:"hidden",flexShrink:0 }}>
              <img src={meal.img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:4 }}>{meal.name}</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginBottom:6 }}>{meal.cal} cal · {meal.protein}g protein</div>
              <div style={{ fontFamily:FONT,fontSize:11,color:"#666" }}>{meal.desc}</div>
            </div>
          </div>
          {/* Swap section */}
          {showSwap ? (
            <div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginBottom:8 }}>Choose a replacement:</div>
              <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                {MEALS.filter((_,i)=>i!==mealIdx).slice(0,3).map((m,i)=>(
                  <button key={i} onClick={()=>{ setMealIdx(MEALS.indexOf(m)); setShowSwap(false); setSwapCount(n=>n+1); }}
                    style={{ display:"flex",alignItems:"center",gap:10,background:"#1a1a1a",borderRadius:12,padding:"10px",border:`1px solid ${BORDER}`,cursor:"pointer" }}>
                    <img src={m.img} alt="" style={{ width:40,height:40,borderRadius:8,objectFit:"cover" }}/>
                    <div style={{ flex:1,textAlign:"left" }}>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>{m.name}</div>
                      <div style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>{m.cal} cal</div>
                    </div>
                  </button>
                ))}
              </div>
              <button onClick={()=>setShowSwap(false)} style={{ background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontSize:12,fontWeight:600,color:"#666",cursor:"pointer",width:"100%",padding:"9px 0",borderRadius:50,marginTop:10 }}>Cancel</button>
            </div>
          ) : (
            <button onClick={()=>{ if(swapCount>=MAX_SWAPS) return; setShowSwap(true); }}
              style={{ width:"100%",marginTop:10,padding:"9px 0",borderRadius:50,background:"transparent",border:`1.5px solid ${swapCount>=MAX_SWAPS?"#e0e0e0":"rgba(0,163,255,0.35)"}`,fontFamily:FONT,fontWeight:700,fontSize:13,color:swapCount>=MAX_SWAPS?"#aaa":PRIMARY,cursor:swapCount>=MAX_SWAPS?"default":"pointer" }}>
              {swapCount>=MAX_SWAPS?"No more swaps today":`Not feeling this? Swap meal (${MAX_SWAPS-swapCount} left)`}
            </button>
          )}
        </div>

        {/* Water Intake */}
        <div style={{ background:CARD,borderRadius:20,padding:"16px",marginBottom:14,border:`1px solid ${BORDER}` }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff" }}>Water Intake</div>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888" }}>{waterGlasses}/{WATER_GOAL} glasses</div>
          </div>
          <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
            {Array.from({length:WATER_GOAL}).map((_,i)=>(
              <button key={i} onClick={()=>setWaterGlasses(i<waterGlasses?i:i+1)}
                style={{ width:36,height:36,borderRadius:10,background:i<waterGlasses?`${PRIMARY}30`:"#1a1a1a",border:`1.5px solid ${i<waterGlasses?PRIMARY:BORDER}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={i<waterGlasses?PRIMARY:"none"} stroke={i<waterGlasses?PRIMARY:"#444"} strokeWidth="2"><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></svg>
              </button>
            ))}
          </div>
        </div>

        {/* AI Summary */}
        <div onClick={()=>onNavigate("aiSummary")} style={{ background:CARD,borderRadius:20,padding:"16px",marginBottom:14,border:`1px solid ${BORDER}`,cursor:"pointer",position:"relative",overflow:"hidden" }}>
          <div style={{ fontFamily:FONT,fontSize:11,color:"#666",fontWeight:600,marginBottom:6 }}>AI PERFORMANCE SUMMARY</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#ccc",lineHeight:1.6,filter:"blur(4px)",userSelect:"none" }}>
            Today's session showed exceptional output across all three energy systems. Your cardiovascular endurance metrics have improved 18% over baseline...
          </div>
          <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(10,10,10,0.6)",borderRadius:20 }}>
            <div style={{ textAlign:"center" }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.5" style={{marginBottom:8,display:"block",margin:"0 auto 8px"}}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>Tap to view AI analysis</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── VTRXAppInner ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function VTRXAppInner() {
  const { user, profileImg, isPremium, setIsPremium } = useUser();

  // ── Phase / onboarding state ──────────────────────────────────────────────
  const [phase, setPhase]           = useState("onboarding"); // onboarding | login | preferences | dashboard
  const [screen, setScreen]         = useState(0);
  const [dir, setDir]               = useState(1);
  const goNext = () => { setDir(1);  setScreen(s=>s+1); };
  const goPrev = () => { setDir(-1); setScreen(s=>Math.max(0,s-1)); };
  const goToDashboard = () => setPhase("dashboard");

  // ── Dashboard state ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState(0);
  const [innerPage, setInnerPage] = useState(null);
  const [selectedExercise, setSelectedExercise] = useState(null);
  const [workoutDone, setWorkoutDone] = useState(false);
  const [showComplete, setShowComplete] = useState(false);
  const [mealIdx, setMealIdx] = useState(0);
  const [streakDay, setStreakDay] = useState(7);
  const [energyKey,     setEnergyKey]     = useState("okay");
  const [notifCount,    setNotifCount]    = useState(0);
  const [liveUser,      setLiveUser]      = useState(null);
  const dashScrollRef = useRef(null);
  const savedScrollPos = useRef(0);

  // Load real data on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        // Fetch notification count
        const notifData = await apiCall("/notifications");
        if (notifData.data?.unreadCount !== undefined) {
          setNotifCount(notifData.data.unreadCount);
        }
        // Fetch fresh user profile
        const meData = await apiCall("/auth/me");
        if (meData.data?.user) {
          setLiveUser(meData.data.user);
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("vtrx_user", JSON.stringify(meData.data.user));
          }
        }
      } catch {}
    };
    if (phase === "dashboard") loadData();
  }, [phase]);

  // ── Onboarding screens ────────────────────────────────────────────────────
  if (phase==="onboarding") {
    const isLast = screen === ONBOARDING_SLIDES.length - 1;
    return (
      <div style={{ position:"absolute",inset:0,background:"#000",overflow:"hidden" }}
        onMouseDown={e=>{ mouseStart.current=e.clientX; }}
        onMouseUp={e=>{ if(mouseStart.current!=null){ const dx=e.clientX-mouseStart.current; if(Math.abs(dx)>40){ if(dx<0&&screen<ONBOARDING_SLIDES.length-1) setScreen(s=>s+1); else if(dx>0&&screen>0) setScreen(s=>s-1); } mouseStart.current=null; } }}
        onTouchStart={e=>{ touchStart.current=e.touches[0].clientX; }}
        onTouchEnd={e=>{ if(touchStart.current!=null){ const dx=e.changedTouches[0].clientX-touchStart.current; if(Math.abs(dx)>40){ if(dx<0&&screen<ONBOARDING_SLIDES.length-1) setScreen(s=>s+1); else if(dx>0&&screen>0) setScreen(s=>s-1); } touchStart.current=null; } }}
      >
        {ONBOARDING_SLIDES.map((s,i) => <OnboardSlide key={s.id} slide={s} isActive={i===screen}/>)}

        {/* Progress dots */}
        <div style={{ position:"absolute",top:18,left:0,right:0,display:"flex",justifyContent:"center",zIndex:20 }}>
          {ONBOARDING_SLIDES.map((_,i) => (
            <div key={i} onClick={()=>setScreen(i)} style={{ height:3,width:i===screen?28:18,borderRadius:2,background:i===screen?PRIMARY:"rgba(255,255,255,0.35)",transition:"all 0.3s",margin:"0 4px",cursor:"pointer" }}/>
          ))}
        </div>

        {/* CTA buttons — last slide only, anchored to bottom with safe area */}
        {isLast && (
          <div style={{ position:"absolute",bottom:0,left:0,right:0,zIndex:20,padding:"0 28px 44px",background:"linear-gradient(180deg,transparent 0%,rgba(0,0,0,0.7) 30%,rgba(0,0,0,0.92) 100%)",paddingTop:32,display:"flex",flexDirection:"column",gap:12,animation:"fadeUp 0.5s ease 0.5s both" }}>
            <button onClick={()=>{ setPhase("preferences"); setScreen(0); }}
              style={{ width:"100%",padding:"17px 0",borderRadius:50,border:"none",background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:2,cursor:"pointer",boxShadow:`0 4px 28px ${PRIMARY}55` }}>
              GET STARTED
            </button>
            <button onClick={()=>setPhase("login")}
              style={{ width:"100%",padding:"16px 0",background:"transparent",border:"1.5px solid rgba(255,255,255,0.45)",borderRadius:50,fontFamily:FONT,fontWeight:600,fontSize:14,color:"rgba(255,255,255,0.9)",cursor:"pointer",letterSpacing:0.5 }}>
              Log In
            </button>
            <p style={{ fontFamily:FONT,fontSize:11,color:"rgba(255,255,255,0.4)",textAlign:"center",lineHeight:1.6,margin:0 }}>
              By signing up you agree to our <span style={{ color:PRIMARY,cursor:"pointer" }}>Terms of Service</span> and <span style={{ color:PRIMARY,cursor:"pointer" }}>Privacy Policy</span>
            </p>
          </div>
        )}

        {/* Swipe hint — non-last slides */}
        {!isLast && (
          <div style={{ position:"absolute",bottom:28,left:0,right:0,display:"flex",justifyContent:"center",alignItems:"center",gap:7,zIndex:20,pointerEvents:"none" }}>
            <span style={{ fontFamily:FONT,fontWeight:600,fontSize:13,color:PRIMARY,letterSpacing:1 }}>Swipe</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        )}

        {/* Full-height tap zones — left goes back, right goes forward */}
        {screen > 0 && (
          <div onClick={()=>setScreen(s=>s-1)}
            style={{ position:"absolute",left:0,top:40,bottom:0,width:"25%",zIndex:15,cursor:"pointer" }}/>
        )}
        {!isLast && (
          <div onClick={()=>setScreen(s=>s+1)}
            style={{ position:"absolute",right:0,top:40,bottom:60,width:"30%",zIndex:15,cursor:"pointer" }}/>
        )}
      </div>
    );
  }

  if (phase==="login") return (
    <LoginScreen onLogin={goToDashboard} onSignUp={()=>{ setPhase("preferences"); setScreen(0); }} onForgot={()=>setPhase("forgot")}/>
  );
  if (phase==="forgot") return (
    <ForgotPasswordPage onBack={()=>setPhase("login")}/>
  );

  if (phase==="preferences") {
    const SCREENS = [
      <SignUpScreen              key={0} onContinue={goNext} onBack={()=>setPhase("onboarding")}/>,
      <EmailVerificationScreen   key={1} onContinue={goNext} onBack={goPrev}/>,
      <BodyScreen                key={2} onContinue={goNext} onBack={goPrev}/>,
      <WorkoutScreen             key={3} onContinue={goNext} onBack={goPrev}/>,
      <NutritionScreen           key={4} onContinue={goNext} onBack={goPrev}/>,
      <ChallengeScreen           key={5} onContinue={goNext} onBack={goPrev}/>,
      <PricingScreen             key={6} onContinue={goNext} onBack={goPrev}/>,
      <ReadyScreen               key={7} onFinish={goToDashboard}/>,
    ];
    return SCREENS[Math.min(screen, SCREENS.length-1)];
  }

  // ── Dashboard ───────────────────────────────────────────────────────────────

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    try {
      const cognitoToken = typeof localStorage !== "undefined"
        ? localStorage.getItem("vtrx_cognito_token") : null;
      await apiCall("/auth/logout", {
        method: "POST",
        body:   JSON.stringify({ cognitoAccessToken: cognitoToken }),
      });
    } catch {} finally {
      clearAuth();
    }
    setPhase("onboarding");
    setScreen(0);
    setActiveTab(0);
    setInnerPage(null);
  };

   const TABS = [
    { label:"Home",      iconType:"home"      },
    { label:"Nutrition", iconType:"nutrition" },
    { label:"Workouts",  iconType:"workout"   },
  ];

  const navigate = (page) => {
    if (dashScrollRef.current) savedScrollPos.current = dashScrollRef.current.scrollTop;
    setInnerPage(page);
  };

  const goBack = () => {
    setInnerPage(null);
    setSelectedExercise(null);
    requestAnimationFrame(()=>{
      if (dashScrollRef.current) dashScrollRef.current.scrollTop = savedScrollPos.current;
    });
  };



  // Only show dashboard if phase is dashboard
  if (phase !== "dashboard") return null;

  // Inner pages
  if (innerPage==="aiSummary")     return <AISummaryPage energyKey={energyKey} workoutDone={workoutDone} onBack={goBack}/>;
  if (innerPage==="fitnessStats")  return <FitnessStatsPage onBack={goBack}/>;
  if (innerPage==="notifications") return <NotificationsPage onBack={goBack}/>;
  if (innerPage==="workoutDetail") return <WorkoutDetailPage workout={WEEKLY_WORKOUTS[0]} onBack={goBack}
    onComplete={async ()=>{
      setWorkoutDone(true); setStreakDay(s=>s+1);
      const w = WEEKLY_WORKOUTS[TODAY_IDX % WEEKLY_WORKOUTS.length];
      try {
        await apiCall("/workouts/log", {
          method: "POST",
          body:   JSON.stringify({
            name:           w.name,
            type:           w.type,
            duration:       w.duration,
            caloriesBurned: w.cal,
            generateAI:     true,
            energyLevel:    "okay",
            exercises:      w.exercises.map(e=>({ name:e.name, sets:3, reps:e.detail })),
          }),
        });
        // Refresh streak from backend
        const me = await apiCall("/auth/me");
        if (me.data?.user?.streakDays) setStreakDay(me.data.user.streakDays);
      } catch {}}}
    onExercise={(ex)=>{ setSelectedExercise(ex); setInnerPage("exerciseDetail"); }}/>;
  if (innerPage==="exerciseDetail"&&selectedExercise) return <ExercisePage exercise={selectedExercise} onBack={()=>setInnerPage("workoutDetail")} onComplete={()=>setInnerPage("workoutDetail")}/>;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",overflow:"hidden" }}>
      {/* Workout Complete overlay */}
      {showComplete&&<WorkoutCompleteScreen onClose={()=>setShowComplete(false)} onViewSummary={()=>{ setShowComplete(false); navigate("aiSummary"); }} exercises={WEEKLY_WORKOUTS[0].exercises?.length||3} calories={WEEKLY_WORKOUTS[0].cal} duration={WEEKLY_WORKOUTS[0].duration}/>}

      {/* Main content area */}
      <div style={{ flex:1,position:"relative",overflow:"hidden" }}>
        {activeTab===0&&!innerPage&&(
          <Dashboard
            userProfile={{daysPerWeek:5}}
            scrollRef={dashScrollRef}
            mealIdx={mealIdx}
            setMealIdx={setMealIdx}
            streakDay={streakDay}
            energyKey={energyKey}
            onMoodSelect={(key)=>setEnergyKey(key)}
            onNavigate={(page)=>{ if(page==="workoutDetail"){ setWorkoutDone(false); } navigate(page); }}
          />
        )}
        {activeTab===1&&(
          <NutritionHub onBack={()=>setActiveTab(0)} energyKey={energyKey} onLogout={handleLogout}/>
        )}
        {activeTab===2&&(
          <WeightsHub onLogout={handleLogout}/>
        )}
      </div>

      {/* Bottom nav */}
      {!innerPage&&(
        <div style={{ position:"absolute",bottom:0,left:0,right:0,background:"rgba(10,10,10,0.95)",backdropFilter:"blur(20px)",borderTop:`1px solid ${BORDER}`,display:"flex",padding:"8px 0 24px",zIndex:50 }}>
          {TABS.map((t,i)=>(
            <button key={i} onClick={()=>{ setActiveTab(i); setInnerPage(null); }}
              style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4,background:"none",border:"none",cursor:"pointer",padding:"4px 0" }}>
              <div style={{ width:24,height:24,display:"flex",alignItems:"center",justifyContent:"center" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill={activeTab===i?PRIMARY:"none"} stroke={activeTab===i?PRIMARY:"#555"} strokeWidth="1.8">
                  {t.iconType==="home"&&<><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>}
                  {t.iconType==="nutrition"&&<><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></>}
                  {t.iconType==="workout"&&<><path d="M6 2v6"/><path d="M18 2v6"/><path d="M6 22v-6"/><path d="M18 22v-6"/><path d="M3 9h18v6H3z"/></>}
                </svg>
              </div>
              <span style={{ fontFamily:FONT,fontSize:11,fontWeight:700,letterSpacing:0.3,color:activeTab===i?PRIMARY:"#555" }}>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ROOT APP ──────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function VTRXApp() {
  const [user, setUser] = useState({ name:"Nhamo M", age:"28", gender:"Male", weight:"82", height:"180", goal:"Build Muscle", level:"Intermediate", days:5 });
  const [profileImg, setProfileImg] = useState(null);
  const [isPremium, setIsPremium] = useState(false);
  return (
    <UserCtx.Provider value={{ user, setUser, profileImg, setProfileImg, isPremium, setIsPremium }}>
      <VTRXAppInner/>
    </UserCtx.Provider>
  );
}



export default VTRXApp;

// Bootstrap is handled by main.jsx in Vite
// Only bootstrap if running standalone (not imported as module)
if (typeof document !== "undefined" && !import.meta.env) {
  const root = document.getElementById("root") || (() => { const d = document.createElement("div"); d.id="root"; document.body.appendChild(d); return d; })();
  ReactDOM.createRoot(root).render(React.createElement(VTRXApp));
}
