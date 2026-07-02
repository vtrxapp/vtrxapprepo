import React, { useState, useEffect, useRef, createContext, useContext, useImperativeHandle, forwardRef } from "react";
import { useAuth as useClerkAuth, useSignUp as useClerkSignUp, useSignIn as useClerkSignIn, useClerk } from '@clerk/clerk-react';
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, PaymentRequestButtonElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { getNotificationToken, onForegroundMessage, isPushSupported } from "./firebase";
import { identifyUser, resetAnalytics, track } from "./analytics";
import Hls from "hls.js";

// Stripe.js loaded once at module scope — publishable key is safe in client code
const _stripePromise = import.meta?.env?.VITE_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)
  : null;

// ── API Configuration ─────────────────────────────────────────────────────────
const API_URL = typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL : "";

// When no real backend URL is set, all API calls silently succeed (demo/preview mode)
const DEMO_MODE = false;

// ── API Helper ────────────────────────────────────────────────────────────────
const apiCall = async (endpoint, options = {}) => {
  // Demo/preview mode — no backend configured, return mock success
  if (DEMO_MODE) {
    // Simulate a brief network delay
    await new Promise(r => setTimeout(r, 400));
    // Return plausible mock responses per endpoint
    if (endpoint === "/auth/signup")         return { success:true, data:{ message:"Account created" } };
    if (endpoint === "/auth/confirm-email")  return { success:true, data:{ message:"Verified" } };
    if (endpoint === "/auth/login")          return { success:true, data:{ token:"demo_token", user:{ id:"demo", name:"Demo User", email:"demo@vtrx.app" } } };
    if (endpoint === "/auth/me")             return { success:true, data:{ user:{ id:"demo", name:"Demo User", email:"demo@vtrx.app", isPremium:false, streakDays:7, goal:"Build Muscle", fitnessLevel:"Intermediate", daysPerWeek:5, weight:"82", height:"180", gender:"Male" } } };
    if (endpoint === "/users/profile")       return { success:true, data:{ user:{ id:"demo", name:"Demo User", streakDays:7, goal:"Build Muscle", fitnessLevel:"Intermediate", daysPerWeek:5, weight:"82", height:"180", gender:"Male", workoutsTotal:12 } } };
    if (endpoint.startsWith("/workouts/history")) return { success:true, data:{ logs:[ { id:"1", name:"Chest & Triceps", type:"STRENGTH", duration:45, caloriesBurned:320, completedAt:new Date(Date.now()-86400000).toISOString() }, { id:"2", name:"HIIT Cardio", type:"CARDIO", duration:30, caloriesBurned:280, completedAt:new Date(Date.now()-2*86400000).toISOString() } ] } };
    if (endpoint.startsWith("/workouts/stats"))   return { success:true, data:{ stats:{ totalWorkouts:12, totalCalories:3840, totalMinutes:540, currentStreak:7, thisWeek:4 } } };
    if (endpoint === "/nutrition/meal-plan")       return { success:true, data:{ plan:null } };
    if (endpoint.startsWith("/nutrition/saved"))   return { success:true, data:{ recipes:[] } };
    if (endpoint === "/auth/logout")         return { success:true };
    if (endpoint === "/auth/forgot-password")return { success:true };
    if (endpoint === "/auth/reset-password") return { success:true };
    if (endpoint === "/payments/create-checkout") return { success:true, data:{ url:"#" } };
    if (endpoint === "/notifications")       return { success:true, data:[] };
    if (endpoint === "/users/mood")          return { success:true };
    if (endpoint === "/workouts/log")        return { success:true };
    return { success:true, data:{} };
  }
  const { skipAuthRedirect, ...fetchOptions } = options;

  const attempt = async () => {
    const token = _getClerkToken ? await _getClerkToken() : null;
    const res   = await fetch(`${API_URL}${endpoint}`, {
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...fetchOptions.headers,
      },
      ...fetchOptions,
    });
    const data = await res.json();
    return { res, data };
  };

  // The backend can restart mid-session (e.g. host idle/sleep cycling) — a request
  // landing during that window fails with a raw network error or a spurious 401 that
  // looks identical to a real expired session. Retry once after a short delay before
  // treating it as either, so a several-second restart doesn't sign the user out.
  let res, data;
  try {
    ({ res, data } = await attempt());
  } catch (_networkErr) {
    await new Promise(r => setTimeout(r, 2000));
    ({ res, data } = await attempt());
  }
  if (!data.success && res.status === 401 && !endpoint.startsWith('/auth/')) {
    await new Promise(r => setTimeout(r, 2000));
    ({ res, data } = await attempt());
  }

  if (!data.success && res.status >= 400) {
    // Expired or invalid token on a protected route — clear session and go to login.
    // Callers making their own first authenticated call right after establishing a
    // session (e.g. LoginScreen fetching the profile immediately post-login) pass
    // skipAuthRedirect so a 401 there doesn't force a full sign-out loop — that call
    // already has its own local error handling.
    if (res.status === 401 && !endpoint.startsWith('/auth/') && !skipAuthRedirect) {
      clearAuth();
      if (_onSessionExpired) _onSessionExpired();
    }
    throw Object.assign(new Error(data.message || "Request failed"), { status: res.status, code: data.code });
  }
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
  Object.keys(localStorage)
    .filter(k => k.startsWith('vtrx_'))
    .forEach(k => localStorage.removeItem(k));
};

const getAuthToken = () => _isSignedIn ? 'clerk_active' : null;
const getCachedUser = () => {
  try { return JSON.parse(localStorage.getItem("vtrx_user") || "null"); } catch(_e){ return null; }
};

const getStoredUser = () => {
  try {
    if (typeof localStorage === "undefined") return null;
    const u = localStorage.getItem("vtrx_user");
    return u ? JSON.parse(u) : null;
  } catch(_e){ return null; }
};

const UserCtx = createContext(null);
const useUser = () => useContext(UserCtx);

// ── Session-expiry bridge ──────────────────────────────────────────────────────
// VTRXAppInner registers a handler; apiCall fires it when a 401 is received on
// any non-auth route so the user is sent back to login automatically.
let _onSessionExpired = null;
// Clerk token bridge — VTRXAppInner registers getToken(); apiCall() calls it
let _getClerkToken = null;
let _isSignedIn = false;

// ── Browser back-button bridge ────────────────────────────────────────────────
// Child hubs (WeightsHub, NutritionHub) set this when they have a sub-page open
// so the root popstate handler can delegate to them without prop-drilling.
let _backHandler = null;

// ── Data caches (prevent re-fetching on every tab switch) ─────────────────────
const _weightsCache   = { data: null, fetchedAt: 0 };
const _nutritionCache = {};          // keyed by "filter_userId"
const _savedCache     = { data: null, fetchedAt: 0 };
const _categorizedCache = { data: null, fetchedAt: 0 };
const _videoUrlCache  = new Map();   // key: ymoveId|name → { videoUrl, hlsUrl, cachedAt }
const CACHE_TTL_MS    = 30 * 60 * 1000;   // 30 min
const VIDEO_TTL_MS    = 12 * 60 * 60 * 1000; // 12 h

// ── In-app payment sheet bridge ───────────────────────────────────────────────
// Module-level ref so any component can open the sheet without prop-drilling.
// VTRXAppInner registers the setter; everything else just calls openPaymentSheet().
let _openPaymentSheet = null;
const openPaymentSheet = (plan = "monthly") => {
  track("upgrade_clicked", { plan });
  if (_openPaymentSheet) {
    _openPaymentSheet(plan);
  } else {
    // Fallback redirect if the sheet isn't mounted (e.g. onboarding phase)
    apiCall("/payments/create-checkout", { method:"POST", body:JSON.stringify({ plan }) })
      .then(d => { if (d?.data?.url) window.location.href = d.data.url; })
      .catch(()=>{});
  }
};

// ── Premium gate component ────────────────────────────────────────────────────
function PremiumGate({ feature, children, mini=false }) {
  const { isPremium } = useUser();
  if (isPremium) return children;
  if (mini) return (
    <div style={{position:"relative",overflow:"hidden",borderRadius:16 }}>
      <div style={{ filter:"blur(4px)",pointerEvents:"none",userSelect:"none" }}>{children}</div>
      <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"rgba(10,10,10,0.75)",backdropFilter:"blur(2px)",borderRadius:16,padding:16 }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="2" style={{marginBottom:8}}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        <div style={{ fontFamily:"'Montserrat',sans-serif",fontWeight:800,fontSize:12,color:"#fff",marginBottom:4,textAlign:"center" }}>Premium Feature</div>
        <button onClick={()=>openPaymentSheet()} style={{ padding:"6px 16px",borderRadius:50,background:"#00A3FF",border:"none",fontFamily:"'Montserrat',sans-serif",fontWeight:700,fontSize:11,color:"#fff",cursor:"pointer" }}>Unlock</button>
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
      <button onClick={()=>openPaymentSheet()}
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

const NUTRITION_FILTERS = ["All","High Protein","Low Carb","Vegan","Vegetarian"];
// Maps UI filter label → personalised endpoint tab param
const FILTER_TAB_MAP = {
  "All":          "all",
  "High Protein": "high_protein",
  "Low Carb":     "low_carb",
  "Vegan":        "vegan",
  "Vegetarian":   "vegetarian",
};
const RECIPE_PAGE_SIZE = 10;

// Strip Wikibooks/CC attribution appended by ymove to some recipe descriptions
const cleanRecipeDesc = (s) => {
  if (!s) return '';
  return s
    .replace(/\[Adapted from Wikibooks[^\]]*\]/gi, '')
    .replace(/Adapted from Wikibooks[^.]*\./gi, '')
    .replace(/\(CC BY[^)]*\)/gi, '')
    .replace(/https?:\/\/en\.wikibooks\.org\S*/gi, '')
    .replace(/https?:\/\/\S+wikibooks\S*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

const normalizeInstructions = (r) => {
  const raw = r.instructions ?? r.steps ?? r.directions ?? r.method ?? null;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map(s =>
      typeof s === 'string' ? s.trim()
      : s.description || s.step || s.text || s.body || String(s)
    ).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  }
  return [];
};

// Extract prep time (in minutes) from free text — title or description
const extractMinsFromText = (text) => {
  if (!text) return 0;
  const minMatch = text.match(/(\d+)\s*[-–]?\s*(?:minute|min|mins)/i);
  if (minMatch) return parseInt(minMatch[1], 10);
  const hrMatch = text.match(/(\d+)\s*hour/i);
  if (hrMatch) return parseInt(hrMatch[1], 10) * 60;
  return 0;
};

// Normalise ymove/DB recipe → shape RecipeFullPage expects
const normalizeRecipe = (r) => {
  const structuredMins = r.prepTimeMinutes || r.prep_time || r.prepTime || r.mins;
  const prepMins = structuredMins ||
    extractMinsFromText(r.name || r.title) ||
    extractMinsFromText(r.description || r.summary || r.desc) ||
    0;
  return ({
  id:          r.id,
  ymoveId:     r.ymoveId || null,
  name:        r.name || r.title || 'Recipe',
  img:         r.image_url || r.imageUrl || r.thumbnail_url || r.thumbnailUrl || r.image || r.img || '',
  cal:         Math.round((r.calories || r.cal || 0) / 10) * 10,
  protein:     Math.round(r.protein  || 0),
  fats:        r.fat      || r.fats  || 0,
  carbs:       r.carbs    || r.carbohydrates || 0,
  mins:        prepMins,
  time:        `${prepMins} min`,
  prep:        `${prepMins} min`,
  servings:    r.servings  || 1,
  desc:        cleanRecipeDesc(r.description || r.summary || r.desc || r.shortDescription || ''),
  ingredients: (r.ingredients || []).map(ing => {
    if (typeof ing === 'string') return ing;
    // ymove uses 'quantity' not 'amount'; unit is separate; ingredient name may be in 'ingredient'
    const qty   = ing.amount ?? ing.quantity ?? ing.qty ?? '';
    const unit  = ing.unit  ?? ing.measure ?? '';
    const name  = ing.name  ?? ing.ingredient ?? ing.item ?? '';
    const qtyStr = qty !== '' && qty !== 0 ? String(qty) : '';
    return [qtyStr, unit, name].filter(Boolean).join(' ') || String(ing);
  }),
  steps:       normalizeInstructions(r),
  tags:        r.tags || r.categories || r.cat || [],
  });
};

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

// Rotates daily (Mon–Sun). Each entry drives the VTRX Smart Nutrition banner.
// showRecipe: only true for food-focused topics; false for hydration/sleep/mindset etc.
const DAILY_NUTRITION_FACTS = [
  {
    focus:      "Carbohydrates & Energy",
    fact:       "Complex carbs are your body's preferred fuel source. Unlike simple sugars, they digest slowly — giving you steady energy throughout your workout and keeping you fuller for longer.",
    examples:   "Best sources: oats, sweet potatoes, brown rice, quinoa, lentils, whole-grain bread, chickpeas.",
    recipeTag:  "High Protein",
    showRecipe: true,
  },
  {
    focus:      "Protein & Muscle Recovery",
    fact:       "After training, your muscle fibres micro-tear and need protein to rebuild stronger. Spread your intake across meals — your body can only absorb around 30–40 g per sitting.",
    examples:   "Best sources: chicken breast, eggs, Greek yoghurt, cottage cheese, salmon, tofu, edamame.",
    recipeTag:  "High Protein",
    showRecipe: true,
  },
  {
    focus:      "Healthy Fats",
    fact:       "Healthy fats support hormone production, joint lubrication, and help absorb fat-soluble vitamins (A, D, E, K). They also provide long-lasting energy, ideal for lower-intensity days.",
    examples:   "Best sources: avocado, extra-virgin olive oil, almonds, walnuts, chia seeds, fatty fish, nut butters.",
    recipeTag:  "Low Carb",
    showRecipe: true,
  },
  {
    focus:      "Hydration & Performance",
    fact:       "Even 2% dehydration can reduce strength and endurance by up to 20%. Water regulates body temperature, carries nutrients to cells, and removes waste from muscles.",
    examples:   "Aim for 2.5–3.5 L daily. Around intense sessions, add electrolytes: sodium, potassium, magnesium.",
    showRecipe: false,
  },
  {
    focus:      "Pre-Workout Nutrition",
    fact:       "Eating 1–2 hours before training fills your glycogen stores and gives muscles a pool of amino acids to draw from — directly improving power output and delaying fatigue.",
    examples:   "Ideas: banana + peanut butter, oat porridge with berries, brown rice with chicken, rice cakes + turkey.",
    recipeTag:  "High Protein",
    showRecipe: true,
  },
  {
    focus:      "Post-Workout Nutrition",
    fact:       "The 30–60 min window after training is prime for nutrient uptake. Fast protein triggers muscle protein synthesis, while carbs replenish glycogen and blunt the cortisol spike.",
    examples:   "Ideas: protein shake + banana, Greek yoghurt with granola, chicken & rice bowl, salmon with sweet potato.",
    recipeTag:  "High Protein",
    showRecipe: true,
  },
  {
    focus:      "Micronutrients & Vitamins",
    fact:       "Vitamins and minerals act as co-factors in hundreds of metabolic reactions. Iron carries oxygen to muscles, magnesium calms the nervous system, and vitamin C speeds tissue repair.",
    examples:   "Eat the rainbow: leafy greens, berries, bell peppers, pumpkin seeds, legumes, citrus fruit, dark chocolate.",
    showRecipe: false,
  },
];

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
  // peak — lightning bolt (maximum effort / explosive energy)
  return <svg {...s} stroke={color} fill={color}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
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
  if (type==="muscle"||type==="muscle") return <svg {...s}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
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
    headline: ["Transform your body.", "Break past limits.", "Become unstoppable."],
    body: "This isn't just about workouts — it's about redefining what you're capable of. Your goals, your pace, your evolution.",
  },
  {
    id: 1, bg: "https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=800&q=80",
    overlay: "linear-gradient(180deg,rgba(0,0,0,0.25) 0%,rgba(0,0,0,0.5) 40%,rgba(0,0,0,0.88) 100%)",
    tag: "CUSTOM WORKOUTS",
    headline: ["Move with purpose.", "Build strength at your pace.", "Track every gain."],
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
               { icon: "fire",  text: "Goal-aligned meal recipes" },
               { icon: "drop",  text: "Hydration & supplement guides" }],
  },
  {
    id: 4, bg: "https://images.unsplash.com/photo-1550345332-09e3ac987658?w=800&q=80",
    overlay: "linear-gradient(180deg,rgba(0,0,0,0.45) 0%,rgba(0,0,0,0.5) 35%,rgba(0,0,0,0.92) 100%)",
    tag: "START YOUR JOURNEY",
    headline: ["Your goals.", "Your plan.", "Your AI coach.", "Let's get to work."],
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

function FitnessStatsPage({ onBack, loggedWorkouts=[] }) {
  const { isPremium, setIsPremium } = useUser();
  const statsScrollRef = useScrollPos("fitness-stats");
  const [week, setWeek]     = useState(0); // 0 = current week, cannot go below 0
  const [dir, setDir]       = useState(0); // -1 left, 1 right for animation
  const [animKey, setAnimKey] = useState(0);
  const [apiStats, setApiStats] = useState(null);
  const touchStartX = useRef(null);

  useEffect(()=>{
    apiCall('/workouts/stats')
      .then(d=>{ if(d?.data?.stats) setApiStats(d.data.stats); })
      .catch(()=>{});
  }, []);

  // Build weeks array: current week from API, older weeks from static data
  const getWeekLabel = () => {
    const d = new Date();
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const start = new Date(d); start.setDate(d.getDate() - dow);
    const end   = new Date(start); end.setDate(start.getDate() + 6);
    const fmt = x => x.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    return `${fmt(start)} – ${fmt(end)}`;
  };
  // Merge loggedWorkouts into current week
  const buildLiveDays = () => {
    const DAY_NAMES = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    const base = apiStats?.dailyBreakdown || DAY_NAMES.map(day=>({ day, cal:0, type:"rest" }));
    const merged = base.map(d=>({...d}));
    const now2 = new Date();
    const dow2 = now2.getDay()===0 ? 6 : now2.getDay()-1;
    const wStart = new Date(now2); wStart.setDate(now2.getDate()-dow2); wStart.setHours(0,0,0,0);
    const wEnd   = new Date(wStart); wEnd.setDate(wStart.getDate()+6); wEnd.setHours(23,59,59,999);
    loggedWorkouts.forEach(lw=>{
      const d = new Date(lw.date||lw.completedAt);
      if (d >= wStart && d <= wEnd) {
        const idx = d.getDay()===0 ? 6 : d.getDay()-1;
        merged[idx] = { day: DAY_NAMES[idx], cal: lw.cal||lw.caloriesBurned||0, type: (lw.type||"strength").toLowerCase() };
      }
    });
    return merged;
  };
  const liveWeek = (apiStats?.dailyBreakdown || loggedWorkouts.length > 0)
    ? { label: getWeekLabel(), days: buildLiveDays(), bestDays: [], improvement: "Live" }
    : WEEKS_DATA[0];
  const allWeeks  = [liveWeek, ...WEEKS_DATA.slice(1)];
  const MAX_WEEK  = allWeeks.length - 1;

  const goTo = (next) => {
    if (next < 0 || next > MAX_WEEK) return; // boundary guard
    if (!isPremium && next > 0) { openPaymentSheet(); return; } // older weeks = premium only
    setDir(next > week ? 1 : -1);
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

  const w = allWeeks[week] || allWeeks[0];
  const calDays  = w.days.filter(d => d.cal > 0);
  const maxCal   = Math.max(...w.days.map(d => d.cal), 1);
  const minCal   = calDays.length ? Math.min(...calDays.map(d => d.cal)) : 0;
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
              {allWeeks.map((_,i)=>(
                <div key={i} style={{ width:i===(MAX_WEEK-week)?18:6,height:6,borderRadius:3,background:i===(MAX_WEEK-week)?PRIMARY:"#2a2a2a",transition:"all 0.2s" }}/>
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
          {week===0 ? "Swipe left for earlier weeks" : week===MAX_WEEK ? "Swipe right for more recent weeks" : "Swipe to navigate weeks"}
        </div>
      </div>

      {/* Swipeable content */}
      <div key={animKey} ref={statsScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 40px",...slideAnim }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>

        {/* Bar chart */}
        {(()=>{
          const MAX_BAR = 110;
          const todayIdx = new Date().getDay()===0 ? 6 : new Date().getDay()-1;
          return (
            <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px 16px",marginBottom:14 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18 }}>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff" }}>Weekly Progress</div>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:PRIMARY }}>{calDays.length}/7 days</div>
              </div>
              <div style={{ display:"flex",gap:4,alignItems:"flex-end",height:MAX_BAR+34+"px" }}>
                {w.days.map((d,i)=>{
                  const hpx   = d.cal>0 ? Math.max(14, Math.round((d.cal/maxCal)*MAX_BAR)) : 0;
                  const color = d.cal>0 ? (TYPE_COLOR[d.type]||PRIMARY) : null;
                  const isToday = week===0 && i===todayIdx;
                  return (
                    <div key={i} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end",height:"100%",gap:4 }}>
                      <div style={{ fontFamily:FONT,fontSize:9,fontWeight:700,color:color||"transparent",minHeight:14,textAlign:"center",lineHeight:1 }}>
                        {d.cal>0 ? d.cal : ""}
                      </div>
                      {d.cal>0 ? (
                        <div style={{
                          width:"100%",
                          height:hpx+"px",
                          background:`linear-gradient(180deg,${color},${color}bb)`,
                          borderRadius:"5px 5px 0 0",
                          boxShadow:`0 0 8px ${color}55`,
                          transition:"height 0.5s ease",
                        }}/>
                      ) : (
                        <div style={{ width:"100%",height:4,background:"#1e1e1e",borderRadius:2 }}/>
                      )}
                      <div style={{ fontFamily:FONT,fontSize:10,fontWeight:isToday?800:500,color:isToday?"#fff":"#555",letterSpacing:0.3 }}>
                        {d.day}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ display:"flex",gap:14,marginTop:14,flexWrap:"wrap" }}>
                {[["#00A3FF","Strength"],["#F59E0B","Cardio"],["#6366F1","HIIT"],["#22C55E","Mobility"]].map(([c,l])=>(
                  <div key={l} style={{ display:"flex",alignItems:"center",gap:5 }}>
                    <div style={{ width:8,height:8,borderRadius:"50%",background:c }}/>
                    <span style={{ fontFamily:FONT,fontSize:10,color:"#666" }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Stat grid */}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12 }}>
          {[
            { iconBg:"#DC2626", label:"Average Calories",   val:avgCal,         svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
            { iconBg:"#6366F1", label:"Workouts This Week", val:calDays.length, svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg> },
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
// Module-level cache: recipe detail fetched once per session, re-opens are instant
const _recipeDetailCache = {};

function RecipeFullPage({ recipe, r, isSaved, saved, onSave, onToggleSave, onBack }) {
  const base   = recipe || r;
  const isS    = isSaved !== undefined ? isSaved : (saved || false);
  const doSave = onSave || onToggleSave || (()=>{});
  const [checked,    setChecked]    = useState([]);
  const [rating,     setRating]     = useState(0);
  const [hovered,    setHovered]    = useState(0);
  const [rated,      setRated]      = useState(false);
  const [showRating, setShowRating] = useState(false);
  // Fetch full recipe detail to get instructions (search results omit them)
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!base) return;
    const lookupId = base.id || base.ymoveId;
    if (!lookupId) return;
    // Serve from cache instantly on re-open
    if (_recipeDetailCache[lookupId]) {
      setDetail(_recipeDetailCache[lookupId]);
      return;
    }
    apiCall(`/nutrition/recipes/${lookupId}`)
      .then(d => {
        if (d?.data?.recipe) {
          const normalized = normalizeRecipe(d.data.recipe);
          _recipeDetailCache[lookupId] = normalized;
          setDetail(normalized);
        }
      })
      .catch(() => {});
  }, [base?.id]);
  // Merge: use base as shell, overlay detail fields when available
  const meal = detail
    ? { ...base, ...detail, desc: detail.desc || base?.desc, img: base?.img || detail.img }
    : base;
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
function WorkoutCompleteScreen({ workoutName, date, time, calories, durationMins, exercises, streakDay, onViewAI, onDone }) {
  const [show,    setShow]    = useState(false);
  const [confetti, setConfetti] = useState([]);
  const { isPremium } = useUser();

  useEffect(()=>{
    const t = setTimeout(()=>setShow(true), 80);
    // Generate confetti pieces
    setConfetti(Array.from({length:20}, (_,i)=>({
      id: i,
      top:   (5  + Math.random() * 85) + "%",
      left:  (Math.random() * 100)     + "%",
      size:  5 + Math.random() * 8,
      color: ["#00A3FF","#22C55E","#F59E0B","#EF4444","#8B5CF6","#FF6B35"][i%6],
      round: Math.random() > 0.5,
      delay: Math.random() * 0.5,
    })));
    return ()=>clearTimeout(t);
  }, []);

  const milestones = [3,7,14,30];
  const isMilestone = milestones.includes(streakDay);
  const stats = [
    { label:"Calories",  value: calories,             unit:"kcal", color:"#EF4444" },
    { label:"Duration",  value: durationMins,         unit:"min",  color:"#22C55E" },
    { label:"Exercises", value: exercises,             unit:"done", color:"#00A3FF" },
  ];

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"28px 24px",zIndex:200,overflowY:"auto" }}>

      {/* Confetti */}
      {show && confetti.map(p=>(
        <div key={p.id} style={{ position:"absolute",top:p.top,left:p.left,width:p.size,height:p.size,borderRadius:p.round?"50%":"2px",background:p.color,opacity:0.75,animation:`confettiFall ${0.8+p.delay}s ease-out both`,animationDelay:p.delay+"s",pointerEvents:"none" }}/>
      ))}

      {/* Trophy icon */}
      <div style={{ width:90,height:90,borderRadius:"50%",background:"rgba(0,163,255,0.12)",border:"2px solid rgba(0,163,255,0.4)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:20,animation:show?"bounceIn 0.5s ease both":"none" }}>
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="1.5">
          <path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/>
          <path d="M4 22h16"/>
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
          <path d="M18 2H6v7a6 6 0 0012 0V2z"/>
        </svg>
      </div>

      {/* Title */}
      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:"#fff",marginBottom:6,textAlign:"center",lineHeight:1.2 }}>
        {isMilestone ? "Day "+streakDay+" Streak!" : "Workout Complete!"}
      </div>
      <div style={{ fontFamily:FONT,fontWeight:600,fontSize:13,color:"#555",marginBottom:4,textAlign:"center" }}>
        {workoutName}
      </div>
      <div style={{ fontFamily:FONT,fontSize:12,color:"#444",marginBottom:16,textAlign:"center" }}>
        {date}{time ? " · " + time : ""}
      </div>

      {/* Milestone banner */}
      {isMilestone&&(
        <div style={{ background:"rgba(0,163,255,0.1)",border:"1px solid rgba(0,163,255,0.3)",borderRadius:14,padding:"10px 20px",marginBottom:16,textAlign:"center",width:"100%" }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:PRIMARY }}>
            {streakDay===3?"Building momentum. Keep going.":streakDay===7?"One full week. Real habits form here.":streakDay===14?"Two weeks in. This is who you are now.":"30 days. Top 6% of all users."}
          </div>
        </div>
      )}

      {/* Stats row */}
      <div style={{ display:"flex",gap:10,marginBottom:24,width:"100%" }}>
        {stats.map((s,i)=>(
          <div key={i} style={{ flex:1,background:CARD,borderRadius:16,border:`1px solid ${BORDER}`,padding:"16px 8px",textAlign:"center" }}>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:24,color:s.color,marginBottom:2,lineHeight:1 }}>{s.value}</div>
            <div style={{ fontFamily:FONT,fontSize:9,color:"#666",letterSpacing:0.8,marginBottom:2 }}>{s.unit.toUpperCase()}</div>
            <div style={{ fontFamily:FONT,fontSize:10,color:"#555",letterSpacing:0.5 }}>{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* AI notification info */}
      <div style={{ background:"rgba(109,40,217,0.1)",border:"1px solid rgba(109,40,217,0.3)",borderRadius:14,padding:"12px 16px",marginBottom:20,width:"100%",display:"flex",alignItems:"center",gap:12 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="1.8" style={{flexShrink:0}}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        <div>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#8B5CF6" }}>AI Summary Processing</div>
          <div style={{ fontFamily:FONT,fontSize:11,color:"#555",marginTop:2 }}>You'll be notified via the bell when your analysis is ready.</div>
        </div>
      </div>

      {/* Buttons */}
      <button onClick={onViewAI} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",marginBottom:12,boxShadow:`0 4px 24px ${PRIMARY}44`,letterSpacing:1 }}>
        {isPremium ? "VIEW AI ANALYSIS" : "PREVIEW AI ANALYSIS"}
      </button>
      <button onClick={onDone} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:"transparent",border:`1.5px solid ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:14,color:"#888",cursor:"pointer" }}>
        Back to Home
      </button>
    </div>
  );
}


function AiTipIcon({ type }) {
  const s = { width:14, height:14, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:"2" };
  if (type==="clock")     return <svg {...s}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
  if (type==="target")    return <svg {...s}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>;
  if (type==="muscle")    return <svg {...s}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
  if (type==="lightbulb") return <svg {...s}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17H8v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
// Convert reps range "8-12" → single target "10" (midpoint)
function parseReps(repsStr) {
  if (!repsStr) return '10';
  const s = String(repsStr);
  if (s.includes('s')) return s; // timed e.g. "45s"
  const m = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (m) return String(Math.round((parseInt(m[1]) + parseInt(m[2])) / 2));
  return s;
}

// Generate a descriptive workout title from the exercises' muscle groups
function generateWorkoutTitle(exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0) return null;
  const norm = (mg) => {
    const m = (mg || '').toLowerCase();
    if (m.includes('bicep'))                                        return 'Biceps';
    if (m.includes('tricep'))                                       return 'Triceps';
    if (m.includes('chest') || m.includes('pec'))                  return 'Chest';
    if (m.includes('back') || m.includes('lat') || m.includes('trap') || m.includes('rhomboid')) return 'Back';
    if (m.includes('shoulder') || m.includes('delt'))              return 'Shoulders';
    if (m.includes('quad') || m.includes('hamstring') || (m.includes('leg') && !m.includes('bicep'))) return 'Legs';
    if (m.includes('glute') || m.includes('hip'))                  return 'Glutes';
    if (m.includes('calf') || m.includes('calve'))                 return 'Calves';
    if (m.includes('core') || m.includes('ab'))                    return 'Core';
    if (m.includes('forearm'))                                     return 'Forearms';
    return null;
  };
  const upper = new Set(['Biceps','Triceps','Chest','Back','Shoulders','Forearms']);
  const lower = new Set(['Legs','Glutes','Calves']);
  const groups = [...new Set(exercises.map(e => norm(e.muscleGroup || e.muscles)).filter(Boolean))];
  if (groups.length === 0) return null;
  const hasUpper = groups.some(g => upper.has(g));
  const hasLower = groups.some(g => lower.has(g));
  if (groups.length === 1) return groups[0];
  if (groups.length === 2) return `${groups[0]} & ${groups[1]}`;
  if (groups.length === 3) return `${groups[0]}, ${groups[1]} & ${groups[2]}`;
  if (hasUpper && hasLower) return 'Full Body';
  if (hasUpper) return 'Upper Body';
  if (hasLower) return 'Lower Body';
  return groups.slice(0, 3).join(', ');
}

// Normalise an exercise from either the API shape or the hardcoded EXERCISES shape
function normaliseExercise(ex) {
  // ymove /workouts/generate nests the exercise inside an 'exercise' key;
  // flatten it before normalising so all fields are at the top level
  const src = (ex.exercise && typeof ex.exercise === 'object') ? { ...ex.exercise, sets: ex.sets, reps: ex.reps, restSecs: ex.restSeconds ?? ex.restSecs } : ex;

  // video URL: direct field, or primary video from videos array
  const primaryVideo = Array.isArray(src.videos)
    ? (src.videos.find(v => v.isPrimary) || src.videos[0])
    : null;
  const videoUrl = src.videoUrl || primaryVideo?.videoUrl || null;
  const thumbUrl = src.thumbnailUrl || primaryVideo?.thumbnailUrl || src.img || null;

  return {
    id:           src.id           || null,
    name:         src.title        || src.name         || 'Exercise',
    sets:         src.sets         || 3,
    reps:         src.reps         || '8-12',
    muscles:      src.muscleGroup  || src.muscles || '',
    equipment:    src.equipment    || null,
    cal:          src.cal          || 0,
    img:          thumbUrl,
    videoUrl,
    hlsUrl:       src.hlsUrl       || null,
    ymoveId:      src.ymoveId      || null,
    thumbnailUrl: thumbUrl,
    restSecs:     src.restSecs     || src.restSeconds || 60,
    instructions: src.instructions || null,
    description:  src.description  || null,
  };
}

function RestDayView() {
  return (
    <div style={{ display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'40px 24px',textAlign:'center',height:'100%' }}>
      <div style={{ fontSize:64,marginBottom:16 }}>😴</div>
      <h2 style={{ fontSize:24,fontWeight:700,color:'#FFFFFF',marginBottom:8,fontFamily:FONT }}>Rest Day</h2>
      <p style={{ fontSize:16,color:'#888888',lineHeight:1.6,maxWidth:280,fontFamily:FONT,marginBottom:0 }}>
        Recovery is where growth happens. Your body is repairing and getting stronger. Take it easy today.
      </p>
      <div style={{ marginTop:24,padding:'16px 20px',background:'#1A1A2E',borderRadius:12,width:'100%',maxWidth:320 }}>
        <p style={{ fontSize:14,color:PRIMARY,fontWeight:600,marginBottom:8,fontFamily:FONT }}>Rest day suggestions:</p>
        <p style={{ fontSize:13,color:'#AAAAAA',fontFamily:FONT,marginBottom:4 }}>• Light walking or stretching</p>
        <p style={{ fontSize:13,color:'#AAAAAA',fontFamily:FONT,marginBottom:4 }}>• Foam rolling or yoga</p>
        <p style={{ fontSize:13,color:'#AAAAAA',fontFamily:FONT,marginBottom:0 }}>• Prioritise sleep and hydration</p>
      </div>
    </div>
  );
}

function WorkoutDetailPage({ workout, onBack, onComplete, onStop, onExercise, completedExercises=[], elapsed=0, started=false, onStart, paused=false, onTogglePause }) {
  const wdpScrollRef = useScrollPos("workout-detail");
  const [completedEx, setCompletedEx] = useState([]);
  const [showStopModal, setShowStopModal] = useState(false);

  const exercises = (Array.isArray(workout?.exercises) && workout.exercises.length > 0)
    ? workout.exercises.map(normaliseExercise)
    : typeof workout?.exercises === 'number' && workout.exercises > 0
      ? EXERCISES.slice(0, workout.exercises).map(normaliseExercise)
      : EXERCISES.map(normaliseExercise);

  const fmt     = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  const toggleEx = (i) => setCompletedEx(p => p.includes(i) ? p.filter(x=>x!==i) : [...p,i]);
  const doneCt  = exercises.filter((ex, i) =>
    (completedEx.includes(i) && !completedEx.includes(`skip_${i}`)) || completedExercises.includes(ex.name)
  ).length;
  const allDone = doneCt === exercises.length && exercises.length > 0;

  const handleStop = () => {
    setShowStopModal(false);
    const pct = exercises.length > 0 ? Math.round((doneCt / exercises.length) * 100) : 0;
    if (onStop) onStop(elapsed, completedEx, pct);
  };

  if (workout?.isRestDay) {
    return (
      <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
        <div style={{ display:"flex",alignItems:"center",padding:"54px 18px 14px",gap:12,borderBottom:`1px solid ${BORDER}` }}>
          <button onClick={onBack} style={{ background:"none",border:"none",cursor:"pointer",padding:4,display:"flex",alignItems:"center" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff" }}>Today's Plan</span>
        </div>
        <RestDayView/>
      </div>
    );
  }

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* Stop confirmation modal */}
      {showStopModal && (
        <>
          <div onClick={()=>setShowStopModal(false)} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.82)",zIndex:90 }}/>
          <div style={{ position:"absolute",bottom:0,left:0,right:0,background:CARD,borderRadius:"24px 24px 0 0",padding:"28px 24px 44px",zIndex:91,border:`1px solid ${BORDER}`,borderBottom:"none" }}>
            <div style={{ display:"flex",justifyContent:"center",marginBottom:20 }}><div style={{ width:40,height:4,borderRadius:2,background:"#2a2a2a" }}/></div>
            <div style={{ textAlign:"center",marginBottom:24 }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",marginBottom:10 }}>End this workout?</div>
              <div style={{ fontFamily:FONT,fontSize:14,color:"#888",lineHeight:1.6 }}>
                {doneCt > 0
                  ? `You've completed ${doneCt} of ${exercises.length} exercises. Your progress will be saved.`
                  : "Your progress will be saved to history."}
              </div>
            </div>
            <button onClick={()=>setShowStopModal(false)} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1.5,cursor:"pointer",marginBottom:10,boxShadow:`0 4px 24px ${PRIMARY}55` }}>
              CONTINUE WORKOUT
            </button>
            <button onClick={handleStop} style={{ width:"100%",padding:"14px 0",borderRadius:50,background:"transparent",border:"1px solid #333",fontFamily:FONT,fontWeight:700,fontSize:14,color:"#aaa",cursor:"pointer" }}>
              End Workout
            </button>
          </div>
        </>
      )}

      {/* ── HEADER with live timer + pause/play ── */}
      <div style={{ padding:"50px 18px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,background:BG }}>
        <button onClick={()=>{ if(started) setShowStopModal(true); else onBack(); }} style={{ width:38,height:38,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>

        {/* Title + timer */}
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>WORKOUT</div>
          {started && (
            <div style={{ display:"flex",alignItems:"center",gap:8,justifyContent:"center",marginTop:4 }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:paused?"#888":PRIMARY,letterSpacing:3,transition:"color 0.2s" }}>{fmt(elapsed)}</div>
              {paused && <div style={{ fontFamily:FONT,fontSize:10,color:"#888",letterSpacing:1 }}>PAUSED</div>}
            </div>
          )}
        </div>

        {/* Pause/Play button — only when started */}
        {started && !allDone ? (
          <button onClick={()=>{ if(onTogglePause) onTogglePause(); }}
            style={{ width:42,height:42,borderRadius:"50%",background:CARD,border:`2px solid ${paused?"#22C55E":"#333"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"all 0.2s" }}>
            {paused
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="#22C55E"><polygon points="5 3 19 12 5 21"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill={PRIMARY}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            }
          </button>
        ) : (
          <div style={{ width:42,height:42,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
          </div>
        )}
      </div>

      <div style={{ flex:1,overflowY:"auto",paddingBottom:90 }}>
        {/* Summary card */}
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,margin:"0 16px 16px",padding:"20px" }}>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff",textAlign:"center",marginBottom:6 }}>Today's Workout</div>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#aaa",textAlign:"center",marginBottom:18 }}>{generateWorkoutTitle(workout.exercises) || workout.name}</div>
          <div style={{ display:"flex",justifyContent:"space-around" }}>
            {[
              {val:exercises.length,                            lbl:"Exercises",col:"#FF6B35",svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF6B35" strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>},
              {val:workout.calories||workout.cal||0,            lbl:"Calories",col:"#EF4444",svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="#EF4444"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>},
              {val:workout.duration||workout.mins||0,           lbl:"Minutes",col:"#22C55E",svg:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>},
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
          {exercises.length === 0 && (
            <div style={{ textAlign:"center",padding:"40px 20px" }}>
              <div style={{ fontFamily:FONT,fontSize:14,color:"#666" }}>No exercises with video available for this workout.</div>
            </div>
          )}
          {exercises.map((ex,i)=>{
            const done    = completedEx.includes(i) || completedExercises.includes(ex.name);
            const skipped = completedEx.includes(`skip_${i}`);
            return (
              <div key={i} style={{ background:"#fff",borderRadius:18,marginBottom:12,overflow:"hidden",border:done?`2px solid #22C55E`:skipped?`2px solid #F9731633`:`2px solid transparent`,transition:"border-color 0.2s" }}>
                <div style={{ display:"flex",alignItems:"center" }}>
                  <div onClick={()=>onExercise&&onExercise(ex)} style={{ position:"relative",width:90,height:90,flexShrink:0,cursor:"pointer" }}>
                    <img src={ex.thumbnailUrl || ex.img || "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=200&q=70"} alt="" width={90} height={90} loading="lazy" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                    <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.2)",display:"flex",alignItems:"center",justifyContent:"center" }}>
                      <div style={{ width:36,height:36,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 0 12px ${PRIMARY}99` }}>
                        <svg width="11" height="13" viewBox="0 0 11 13" fill="white"><polygon points="0,0 11,6.5 0,13"/></svg>
                      </div>
                    </div>
                  </div>
                  <div onClick={()=>onExercise&&onExercise(ex)} style={{ flex:1,padding:"12px 10px",cursor:"pointer" }}>
                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#111",marginBottom:2 }}>{ex.name}</div>
                    {(()=>{const r=parseReps(ex.reps);const lbl=/^\d+s$/.test(r)?`${ex.sets} sets × ${r.replace(/s$/,' sec')}`:`${ex.sets} sets × ${r} reps`;return<div style={{fontFamily:FONT,fontSize:12,color:"#888888",marginBottom:3}}>{lbl}</div>;})()}
                    <div style={{ fontFamily:FONT,fontSize:11,color:PRIMARY }}>{ex.muscles}</div>
                    {skipped && <div style={{ fontFamily:FONT,fontSize:10,color:"#F97316",marginTop:2,fontWeight:600 }}>Skipped</div>}
                  </div>
                  <div style={{ padding:"0 12px 0 4px",display:"flex",flexDirection:"column",gap:6,alignItems:"center" }}>
                    <button onClick={(e)=>{e.stopPropagation(); if(!skipped) toggleEx(i);}}
                      style={{ width:34,height:34,borderRadius:"50%",background:done?"#22C55E":"#f0f0f0",border:done?"2px solid #22C55E":"2px solid #d0d0d0",display:"flex",alignItems:"center",justifyContent:"center",cursor:skipped?"default":"pointer",transition:"all 0.2s",opacity:skipped?0.3:1 }}>
                      <svg width="14" height="11" viewBox="0 0 14 11" fill="none" stroke={done?"#fff":"#999"} strokeWidth="2.5"><polyline points="1,5.5 5,9.5 13,1"/></svg>
                    </button>
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
          <button onClick={()=>{ if(onStart) onStart(); }} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:`0 4px 28px ${PRIMARY}55` }}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="white"><polygon points="0,0 13,6.5 0,13"/></svg>
            START WORKOUT
          </button>
        ) : allDone ? (
          <button onClick={()=>onComplete(elapsed)} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:"linear-gradient(135deg,#22C55E,#16A34A)",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",boxShadow:"0 4px 24px rgba(34,197,94,0.5)" }}>
            COMPLETE WORKOUT
          </button>
        ) : (
          <div style={{ background:"#111",borderRadius:50,padding:"14px 18px",textAlign:"center" }}>
            <span style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888" }}>{doneCt}/{exercises.length} exercises done</span>
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
// ── VIDEO PLAYER ─────────────────────────────────────────────────────────────
// Full-featured HTML5 video player with seek, fullscreen, PiP, speed control,
// ±10s / +30s jumps, progress tracking, and a "no video" placeholder state.
// ─────────────────────────────────────────────────────────────────────────────
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const VideoPlayer = forwardRef(function VideoPlayer({ videoUrl, hlsUrl = null, thumbnailUrl, exerciseName, onProgress, onVideoComplete, initialPositionSecs = 0, fillContainer = false, onPortraitDetected, videoUrlLoading = false, portraitMode = false }, ref) {
  const videoRef    = useRef(null);
  const containerRef = useRef(null);
  const seekBarRef  = useRef(null);
  const hideTimer   = useRef(null);
  const isDragging  = useRef(false);
  const hlsRef      = useRef(null);

  const [isPlaying,   setIsPlaying]   = useState(false);
  const [currentTime, setCurrentTime] = useState(initialPositionSecs);
  const [duration,    setDuration]    = useState(0);
  const [speedIdx,    setSpeedIdx]    = useState(2);          // 1x default
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP,       setIsPiP]       = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isLoading,   setIsLoading]   = useState(false);
  const [hasError,    setHasError]    = useState(false);

  // Manage video source — HLS via hls.js (Chrome/Firefox) or native (Safari/MP4)
  // ymove may return HLS streams in either videoUrl or hlsUrl field
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    setHasError(false);
    if (!videoUrl && !hlsUrl) return;

    const looksLikeHls = (u) => u && u.toLowerCase().includes('.m3u8');
    // hlsUrl (videoHlsUrl from ymove) is always HLS; videoUrl is direct MP4 unless it ends in .m3u8
    const streamUrl  = hlsUrl || (looksLikeHls(videoUrl) ? videoUrl : null);
    const directUrl  = streamUrl ? null : videoUrl;

    if (streamUrl && Hls.isSupported()) {
      const hls = new Hls({ startLevel: -1 });
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(v);
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          // HLS failed — fall back to direct MP4 if available, else show error
          hls.destroy();
          hlsRef.current = null;
          if (directUrl || videoUrl) {
            setHasError(false);
            v.src = directUrl || videoUrl;
          } else {
            setHasError(true);
          }
        }
      });
    } else if (streamUrl && v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = streamUrl; // Safari native HLS
    } else if (directUrl) {
      v.src = directUrl;
    } else if (videoUrl) {
      v.src = videoUrl; // last resort — try whatever URL we have
    }
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [videoUrl, hlsUrl]);

  const speed = PLAYBACK_SPEEDS[speedIdx];
  const pct   = duration > 0 ? (currentTime / duration) * 100 : 0;

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  // Auto-hide controls while playing
  const resetHideTimer = () => {
    clearTimeout(hideTimer.current);
    setShowControls(true);
    if (isPlaying && !isDragging.current) {
      hideTimer.current = setTimeout(() => setShowControls(false), 3000);
    }
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // Wire video element events
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay     = () => { setIsPlaying(true);  resetHideTimer(); };
    const onPause    = () => { setIsPlaying(false); setShowControls(true); clearTimeout(hideTimer.current); };
    const onLoading  = () => setIsLoading(true);
    const detectPortrait = () => {
      if (onPortraitDetected && v.videoWidth && v.videoHeight) {
        onPortraitDetected(v.videoHeight > v.videoWidth);
      }
    };
    const onCanPlay  = () => { setIsLoading(false); setHasError(false); detectPortrait(); };
    const onMeta     = () => {
      setDuration(v.duration || 0);
      if (initialPositionSecs > 0) v.currentTime = initialPositionSecs;
      detectPortrait(); // may be 0x0 for HLS at this point — onCanPlay catches it
    };
    const onTime     = () => {
      setCurrentTime(v.currentTime);
      if (onProgress && v.duration > 0) onProgress(v.currentTime, v.duration);
    };
    const onEnd      = () => { setIsPlaying(false); setShowControls(true); if (onVideoComplete) onVideoComplete(); };
    const onError    = () => { setIsLoading(false); setHasError(true); };
    const onEnterPiP = () => setIsPiP(true);
    const onLeavePiP = () => setIsPiP(false);
    const onFSChange = () => setIsFullscreen(!!document.fullscreenElement);

    v.addEventListener('play',                     onPlay);
    v.addEventListener('pause',                    onPause);
    v.addEventListener('waiting',                  onLoading);
    v.addEventListener('canplay',                  onCanPlay);
    v.addEventListener('loadedmetadata',           onMeta);
    v.addEventListener('timeupdate',               onTime);
    v.addEventListener('ended',                    onEnd);
    v.addEventListener('error',                    onError);
    v.addEventListener('enterpictureinpicture',    onEnterPiP);
    v.addEventListener('leavepictureinpicture',    onLeavePiP);
    document.addEventListener('fullscreenchange',  onFSChange);
    document.addEventListener('webkitfullscreenchange', onFSChange);

    return () => {
      v.removeEventListener('play',                    onPlay);
      v.removeEventListener('pause',                   onPause);
      v.removeEventListener('waiting',                 onLoading);
      v.removeEventListener('canplay',                 onCanPlay);
      v.removeEventListener('loadedmetadata',          onMeta);
      v.removeEventListener('timeupdate',              onTime);
      v.removeEventListener('ended',                   onEnd);
      v.removeEventListener('error',                   onError);
      v.removeEventListener('enterpictureinpicture',   onEnterPiP);
      v.removeEventListener('leavepictureinpicture',   onLeavePiP);
      document.removeEventListener('fullscreenchange', onFSChange);
      document.removeEventListener('webkitfullscreenchange', onFSChange);
    };
  // videoUrl/hlsUrl added so the effect re-runs when the <video> element first appears
  // (VideoPlayer renders a loading div while videoUrl is null — videoRef is null until URLs arrive)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPositionSecs, videoUrl, hlsUrl]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.readyState >= 2) {
        v.play().catch(() => {});
      } else {
        // Not buffered yet — queue play on canplay
        const onReady = () => { v.play().catch(() => {}); v.removeEventListener('canplay', onReady); };
        v.addEventListener('canplay', onReady);
      }
    } else {
      v.pause();
    }
  };

  // Expose togglePlay to portrait layout via forwardRef
  useImperativeHandle(ref, () => ({ togglePlay }), []);

  const seekBy = (secs) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    v.currentTime = Math.max(0, Math.min(duration, v.currentTime + secs));
    resetHideTimer();
  };

  const seekToRatio = (ratio) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    v.currentTime = Math.max(0, Math.min(duration, ratio * duration));
  };

  const cycleSpeed = (e) => {
    e.stopPropagation();
    const next = (speedIdx + 1) % PLAYBACK_SPEEDS.length;
    setSpeedIdx(next);
    if (videoRef.current) videoRef.current.playbackRate = PLAYBACK_SPEEDS[next];
    resetHideTimer();
  };

  const toggleFullscreen = (e) => {
    e.stopPropagation();
    const el = containerRef.current;
    const v  = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else if (el.requestFullscreen) {
      el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else if (v?.webkitEnterFullscreen) {
      v.webkitEnterFullscreen(); // iOS Safari fallback
    }
  };

  const togglePiP = async (e) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else                                   await v.requestPictureInPicture();
    } catch (_) {}
  };

  // Seek bar interaction (supports both mouse and touch)
  const getSeekRatio = (clientX) => {
    const bar = seekBarRef.current;
    if (!bar) return 0;
    const { left, width } = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - left) / width));
  };

  const onSeekBarDown = (e) => {
    e.stopPropagation();
    isDragging.current = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    seekToRatio(getSeekRatio(clientX));
  };
  const onSeekBarMove = (e) => {
    if (!isDragging.current) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    seekToRatio(getSeekRatio(clientX));
  };
  const onSeekBarUp = () => { isDragging.current = false; resetHideTimer(); };

  const hasPiP = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document;

  // ── No video URL → show loading spinner or placeholder ───────────────────
  if (!videoUrl && !hlsUrl) {
    return (
      <div style={{ position:'relative', width:'100%', height:210, background:'#0a0a0a', overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:10 }}>
        {thumbnailUrl
          ? <img src={thumbnailUrl} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', filter:'brightness(0.35)' }}/>
          : null}
        {videoUrlLoading ? (
          <div style={{ position:'relative', display:'flex', flexDirection:'column', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, border:'2px solid rgba(255,255,255,0.08)', borderTop:'2px solid rgba(255,255,255,0.45)', borderRadius:'50%', animation:'spin 0.8s linear infinite' }}/>
          </div>
        ) : (
          <>
            <div style={{ position:'relative', width:52, height:52, borderRadius:'50%', background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.12)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.5"><polygon points="5 3 19 12 5 21"/></svg>
            </div>
            <span style={{ position:'relative', fontFamily:FONT, fontSize:10, color:'#444', letterSpacing:1.5 }}>VIDEO PREVIEW UNAVAILABLE</span>
          </>
        )}
      </div>
    );
  }

  const playerHeight = fillContainer ? '100%' : (isFullscreen ? '100vh' : 210);

  return (
    <div
      ref={containerRef}
      style={{ position:'relative', width:'100%', height:playerHeight, background:'#000', overflow:'hidden', userSelect:'none', WebkitUserSelect:'none', touchAction:'manipulation' }}
      onClick={() => { togglePlay(); resetHideTimer(); }}
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
    >
      {/* ─ Video element — src is managed imperatively in the hlsRef useEffect above ─ */}
      <video
        ref={videoRef}
        poster={thumbnailUrl || undefined}
        style={{ width:'100%', height:'100%', objectFit: isFullscreen ? 'contain' : 'cover', display:'block' }}
        playsInline
        preload="metadata"
      />

      {/* ─ Loading spinner ─ */}
      {isLoading && (
        <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.4)', pointerEvents:'none' }}>
          <div style={{ width:36, height:36, border:'3px solid rgba(255,255,255,0.2)', borderTopColor:'#fff', borderRadius:'50%', animation:'spin 0.8s linear infinite' }}/>
        </div>
      )}

      {/* ─ Error state ─ */}
      {hasError && (
        <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, background:'rgba(0,0,0,0.7)', pointerEvents:'none' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span style={{ fontFamily:FONT, fontSize:12, color:'#EF4444' }}>Video unavailable</span>
        </div>
      )}

      {/* ─ Controls overlay (auto-hides) — suppressed in portrait mode (controls rendered externally) ─ */}
      {showControls && !hasError && !portraitMode && (
        <>
          {/* Gradient overlay */}
          <div style={{ position:'absolute', inset:0, background:'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, transparent 30%, transparent 60%, rgba(0,0,0,0.75) 100%)', pointerEvents:'none' }}/>

          {/* Top bar: speed | PiP | fullscreen */}
          <div style={{ position:'absolute', top:0, left:0, right:0, display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 12px' }} onClick={e=>e.stopPropagation()}>
            <button
              onClick={cycleSpeed}
              style={{ background:'rgba(0,0,0,0.55)', backdropFilter:'blur(6px)', border:'1px solid rgba(255,255,255,0.15)', borderRadius:20, padding:'4px 11px', cursor:'pointer' }}
            >
              <span style={{ fontFamily:FONT, fontWeight:700, fontSize:11, color:'#fff' }}>{speed}×</span>
            </button>
            <div style={{ display:'flex', gap:8 }}>
              {hasPiP && (
                <button onClick={togglePiP} style={{ width:30, height:30, borderRadius:'50%', background:'rgba(0,0,0,0.55)', backdropFilter:'blur(6px)', border:'1px solid rgba(255,255,255,0.15)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                  {isPiP
                    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="#00A3FF" stroke="none"><rect x="2" y="4" width="20" height="16" rx="2"/></svg>
                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="13" y="11" width="8" height="7" rx="1" fill="#fff" stroke="none"/></svg>}
                </button>
              )}
              <button onClick={toggleFullscreen} style={{ width:30, height:30, borderRadius:'50%', background:'rgba(0,0,0,0.55)', backdropFilter:'blur(6px)', border:'1px solid rgba(255,255,255,0.15)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                {isFullscreen
                  ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="8 3 3 3 3 8"/><polyline points="21 3 16 3 16 8"/><polyline points="3 21 3 16 8 16"/><polyline points="16 21 21 21 21 16"/></svg>
                  : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>}
              </button>
            </div>
          </div>

          {/* Centre playback controls */}
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', gap:28, pointerEvents:'none' }}>
            {/* −10 s */}
            <button onClick={e=>{e.stopPropagation();seekBy(-10);}} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:3, pointerEvents:'all', padding:6 }}>
              <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                <path d="M6.5 4.5A10.5 10.5 0 1 0 13 2.5V5" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
                <polyline points="9,2 13,5 9,8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <text x="9" y="17" fontSize="7" fontWeight="700" fill="#fff" fontFamily="system-ui">10</text>
              </svg>
              <span style={{fontFamily:FONT,fontSize:9,color:'rgba(255,255,255,0.7)',letterSpacing:0.5}}>BACK</span>
            </button>

            {/* Play / Pause */}
            <button onClick={e=>{e.stopPropagation();togglePlay();}} style={{ width:54, height:54, borderRadius:'50%', background:PRIMARY, border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:`0 0 24px ${PRIMARY}88`, pointerEvents:'all' }}>
              {isPlaying
                ? <svg width="17" height="17" viewBox="0 0 24 24" fill="white"><rect x="6"  y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                : <svg width="17" height="17" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>}
            </button>

            {/* +30 s */}
            <button onClick={e=>{e.stopPropagation();seekBy(30);}} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:3, pointerEvents:'all', padding:6 }}>
              <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                <path d="M19.5 4.5A10.5 10.5 0 1 1 13 2.5V5" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
                <polyline points="17,2 13,5 17,8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <text x="8" y="17" fontSize="7" fontWeight="700" fill="#fff" fontFamily="system-ui">30</text>
              </svg>
              <span style={{fontFamily:FONT,fontSize:9,color:'rgba(255,255,255,0.7)',letterSpacing:0.5}}>SKIP</span>
            </button>
          </div>

          {/* Bottom: seek bar + time */}
          <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'0 14px 12px' }} onClick={e=>e.stopPropagation()}>
            {/* Seek bar */}
            <div
              ref={seekBarRef}
              style={{ position:'relative', height:22, display:'flex', alignItems:'center', cursor:'pointer', touchAction:'none' }}
              onMouseDown={onSeekBarDown}
              onMouseMove={onSeekBarMove}
              onMouseUp={onSeekBarUp}
              onMouseLeave={onSeekBarUp}
              onTouchStart={onSeekBarDown}
              onTouchMove={onSeekBarMove}
              onTouchEnd={onSeekBarUp}
            >
              <div style={{ position:'absolute', left:0, right:0, height:3, background:'rgba(255,255,255,0.18)', borderRadius:3 }}>
                <div style={{ height:'100%', width:`${pct}%`, background:PRIMARY, borderRadius:3 }}/>
              </div>
              <div style={{ position:'absolute', left:`${pct}%`, transform:'translateX(-50%)', width:13, height:13, borderRadius:'50%', background:'#fff', boxShadow:`0 0 6px ${PRIMARY}`, transition: isDragging.current ? 'none' : 'left 0.1s' }}/>
            </div>
            {/* Time */}
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:2 }}>
              <span style={{fontFamily:'monospace',fontSize:10,color:'rgba(255,255,255,0.65)'}}>{fmt(currentTime)}</span>
              <span style={{fontFamily:'monospace',fontSize:10,color:'rgba(255,255,255,0.45)'}}>{fmt(duration)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ── EXERCISE INSTRUCTIONS LOOKUP ─────────────────────────────────────────────
// Returns an array of step strings for "How to do this exercise"
// Priority: DB instructions → name lookup → muscle-group fallback
// ─────────────────────────────────────────────────────────────────────────────
const EXERCISE_INSTRUCTIONS_MAP = {
  // ── BICEPS ──────────────────────────────────────────────────────────────
  "alternating dumbbell curl":["Stand with feet shoulder-width apart, a dumbbell in each hand with palms facing forward","Keep your upper arms still and elbows pinned close to your torso throughout","Curl one dumbbell up toward your shoulder, squeezing your bicep hard at the top","Lower slowly over 2–3 seconds, then repeat on the other arm","Alternate sides for each rep — avoid swinging or using momentum"],
  "dumbbell curl":["Stand feet shoulder-width apart, dumbbells at your sides with palms facing forward","Keep elbows pinned to your sides and curl both dumbbells up to shoulder height","Squeeze your biceps hard at the top for a full contraction","Lower slowly over 2–3 seconds back to full extension","Avoid swinging — keep the movement strictly controlled"],
  "bicep curl":["Stand feet shoulder-width apart, dumbbells at your sides with palms facing forward","Keep elbows pinned to your sides and curl both dumbbells up to shoulder height","Squeeze your biceps hard at the top for a full contraction","Lower slowly over 2–3 seconds back to full extension","Avoid swinging — keep the movement strictly controlled"],
  "barbell curl":["Stand feet shoulder-width apart, grip the barbell underhand at hip level","Keep your elbows close to your body and curl the bar up toward your chest","Squeeze your biceps at the top and hold for 1 second","Lower the bar slowly over 2–3 seconds — keep your back straight","Avoid leaning back to cheat the weight up"],
  "hammer curl":["Stand feet shoulder-width apart, dumbbells at your sides with palms facing inward (thumbs up)","Without rotating your wrists, curl both dumbbells up toward your shoulders","Squeeze at the top then lower slowly back over 2–3 seconds","This neutral grip targets the brachialis alongside the biceps for thicker arms"],
  "preacher curl":["Sit at the preacher bench and rest the back of your upper arms flat against the pad","Hold the barbell or dumbbell underhand with arms nearly fully extended","Curl the weight up toward your chin, squeezing your biceps hard at the top","Lower slowly — do not fully lock out at the bottom to keep constant tension"],
  "concentration curl":["Sit on a bench, feet wide apart — rest your right upper arm against your inner right thigh","Hold a dumbbell with your right hand and let it hang fully extended","Curl the weight up toward your shoulder, rotating your pinky slightly outward at the top","Lower slowly and complete all reps before switching arms"],
  "cable curl":["Attach a straight bar or EZ-bar to the low pulley of a cable machine","Stand close, grip the bar underhand at hip height with elbows tucked in","Curl the bar up toward your chest against the constant cable tension","Squeeze at the top then lower slowly — the cable keeps tension through the whole movement"],
  "incline dumbbell curl":["Set a bench to 45–60° incline and sit back with dumbbells hanging at full extension","The incline creates a long-head bicep stretch at the bottom for greater muscle development","Curl both dumbbells up toward your shoulders keeping elbows pulled back","Squeeze at the top and lower slowly — feel the full stretch at the bottom"],
  // ── CHEST ───────────────────────────────────────────────────────────────
  "bench press":["Lie flat on the bench with feet firmly on the floor for stability","Grip the bar slightly wider than shoulder-width with an overhand grip","Unrack the bar and lower it to your mid-chest — keep elbows at 45° from your body","Press the bar upward explosively until your arms are fully extended","Lower the weight slowly over 2–3 seconds — never bounce off your chest"],
  "barbell bench press":["Lie flat on the bench with feet firmly on the floor for stability","Grip the bar slightly wider than shoulder-width with an overhand grip","Lower the bar to your mid-chest — elbows at roughly 45° to your torso","Press upward until arms are fully extended, squeezing your chest at the top","Lower slowly over 2–3 seconds — never bounce off your chest"],
  "dumbbell bench press":["Lie flat on the bench, hold a dumbbell in each hand at chest level","Press both dumbbells upward until your arms are straight, bringing them slightly together","Squeeze your chest at the top of the movement","Lower the dumbbells slowly — feel a stretch across your chest at the bottom","Keep feet flat, back slightly arched, and shoulders retracted throughout"],
  "incline bench press":["Set the bench to 30–45° and lie back with feet flat on the floor","Grip the bar just outside shoulder-width and unrack it","Lower the bar to your upper chest — keep elbows at 45–60° from your body","Press back up powerfully until arms are extended — squeeze your upper chest","Lower slowly — the incline targets the upper pectoral muscle"],
  "incline dumbbell press":["Set the bench to 30–45°, sit back with a dumbbell in each hand resting on your thighs","Kick the dumbbells up as you lie back, positioning them at chest level","Press both dumbbells up and slightly together until arms are straight","Squeeze your upper chest at the top, then lower slowly back to the starting position"],
  "push up":["Place hands slightly wider than shoulder-width on the floor, fingers pointing forward","Start in a straight-arm plank — keep your body in a rigid straight line from head to heels","Lower your chest toward the floor, keeping elbows at roughly 45° from your body","Press back up powerfully until your arms are fully extended","Keep your core tight throughout — don't let your hips sag or pike up"],
  "push-up":["Place hands slightly wider than shoulder-width on the floor, fingers pointing forward","Start in a straight-arm plank — keep your body in a rigid straight line from head to heels","Lower your chest toward the floor, keeping elbows at roughly 45° from your body","Press back up powerfully until your arms are fully extended","Keep your core tight throughout — don't let your hips sag or pike up"],
  "pushup":["Place hands slightly wider than shoulder-width on the floor, fingers pointing forward","Start in a straight-arm plank — keep your body in a rigid straight line from head to heels","Lower your chest toward the floor, keeping elbows at roughly 45° from your body","Press back up powerfully until your arms are fully extended","Keep your core tight throughout — don't let your hips sag or pike up"],
  "dumbbell flye":["Lie flat on a bench, hold dumbbells above your chest with a slight bend in your elbows","Open your arms in a wide arc, lowering dumbbells out to your sides until you feel a chest stretch","Squeeze your chest and bring the dumbbells back together in the same arc motion","Maintain the slight elbow bend throughout — do not straighten or over-bend your arms"],
  "cable flye":["Set both cable stations to the high position and stand in the center","Hold a handle in each hand and lean forward slightly at the hips","Bring your hands together in front of your lower chest in a wide arc, squeezing your pecs","Slowly let your arms return to the starting position — feel the chest stretch"],
  "chest dip":["Grip the parallel bars and support your bodyweight with arms straight","Lean your torso forward slightly — this shifts focus to the chest rather than triceps","Lower your body by bending your elbows until they reach 90° or slightly below","Press back up strongly until arms are fully straight, squeezing your chest at the top"],
  // ── BACK ────────────────────────────────────────────────────────────────
  "pull up":["Hang from the bar with an overhand grip, hands slightly wider than shoulder-width","Start from a dead hang with arms fully extended and shoulders engaged","Pull your chest toward the bar — drive your elbows down and back toward your hips","Squeeze your lats and upper back when your chin clears the bar","Lower yourself slowly over 2–3 seconds back to the full hang"],
  "pull-up":["Hang from the bar with an overhand grip, hands slightly wider than shoulder-width","Start from a dead hang with arms fully extended and shoulders engaged","Pull your chest toward the bar — drive your elbows down and back toward your hips","Squeeze your lats and upper back when your chin clears the bar","Lower yourself slowly over 2–3 seconds back to the full hang"],
  "chin up":["Hang from the bar with an underhand (supinated) grip, hands shoulder-width apart","Start from a dead hang with arms fully extended","Pull your chin above the bar by driving your elbows down and back","Squeeze your biceps and lats at the top, then lower slowly"],
  "lat pulldown":["Sit at the machine and adjust the thigh pad to lock your legs in","Grip the bar slightly wider than shoulder-width with an overhand grip","Lean back slightly and pull the bar down to your upper chest, leading with your elbows","Squeeze your lats hard at the bottom — hold for a second","Slowly return the bar to the top, maintaining muscle tension throughout"],
  "bent over row":["Stand with feet hip-width apart, grip the bar overhand at hip level","Hinge forward at the hips until your torso is roughly parallel to the floor","Keep your back flat, core braced — pull the bar to your lower chest or upper abdomen","Drive your elbows back and squeeze your shoulder blades together at the top","Lower slowly under control back to the start"],
  "barbell row":["Stand with feet hip-width apart, grip the bar overhand at hip level","Hinge forward at the hips until your torso is roughly parallel to the floor","Keep your back flat, core braced — pull the bar to your lower chest or upper abdomen","Drive your elbows back and squeeze your shoulder blades together at the top","Lower slowly under control back to the start"],
  "dumbbell row":["Place your left knee and hand on a flat bench for support","Hold a dumbbell in your right hand and let it hang fully extended","Row the dumbbell to your hip by driving your elbow straight back — keep your back flat","Squeeze your lat at the top and lower slowly","Complete all reps then switch sides"],
  "seated cable row":["Sit at the cable row machine with feet on the platform and knees slightly bent","Grip the handle and sit tall with your back straight and chest up","Pull the handle to your abdomen, driving your elbows back and squeezing your shoulder blades","Hold the contraction for a second, then slowly extend arms back to the start","Avoid rocking your torso — keep the movement isolated to your back"],
  "deadlift":["Stand with feet hip-width apart, barbell over your mid-foot","Hinge at your hips and bend your knees to grip the bar just outside your legs","Take a big breath, brace your core, and drive through your heels to pull the bar up","Keep the bar dragging close to your body — up your shins and thighs","Stand fully upright squeezing glutes at the top, then hinge back down under control"],
  "romanian deadlift":["Stand with feet hip-width apart, hold the barbell in front of your thighs with an overhand grip","Push your hips back while keeping your back flat and chest tall","Lower the bar along your legs until you feel a deep hamstring stretch","Drive your hips forward to return to standing, squeezing your glutes at the top","Keep the bar close to your body and maintain a neutral spine throughout"],
  "rdl":["Stand with feet hip-width apart, hold the barbell in front of your thighs with an overhand grip","Push your hips back while keeping your back flat and chest tall","Lower the bar along your legs until you feel a deep hamstring stretch","Drive your hips forward to return to standing, squeezing your glutes at the top"],
  // ── SHOULDERS ───────────────────────────────────────────────────────────
  "overhead press":["Stand feet shoulder-width apart, hold the barbell at shoulder height with an overhand grip","Brace your core — keep your ribs down and glutes tight to protect your spine","Press the bar straight overhead until your arms are fully extended","Shrug your traps slightly at the top to lock out the shoulder joint","Lower the bar slowly back to your shoulders under control"],
  "barbell overhead press":["Stand feet shoulder-width apart, hold the barbell at shoulder height with an overhand grip","Brace your core — keep your ribs down and glutes tight","Press the bar straight overhead until your arms are fully extended","Shrug your traps slightly at the top to lock out the shoulder joint","Lower the bar slowly back to your shoulders under control"],
  "military press":["Stand feet shoulder-width apart, grip the barbell at shoulder height","Brace your core tightly — do not arch your lower back","Press the bar straight overhead until your arms are fully locked out","Keep the bar over your center of mass throughout the movement","Lower the bar slowly back to shoulder level under control"],
  "dumbbell shoulder press":["Sit on an upright bench, hold dumbbells at shoulder height with palms facing forward","Brace your core and press both dumbbells directly overhead until arms are extended","Bring the dumbbells slightly together at the top without touching","Lower slowly back to shoulder level — full range of motion on every rep"],
  "arnold press":["Sit upright, hold dumbbells in front of your shoulders with palms facing you (like a top curl position)","As you press upward, rotate your palms outward — palms face forward by full extension","Reverse the rotation as you lower back to the starting position","This rotation targets the anterior and medial deltoid across a full range of motion"],
  "lateral raise":["Stand feet shoulder-width apart, hold dumbbells at your sides with a slight elbow bend","Raise both arms out to the sides until they reach shoulder height — lead with your elbows","At the top, let your pinkies be slightly higher than your thumbs for full medial delt activation","Lower the dumbbells slowly over 3 seconds — control the descent","Avoid using momentum — keep the movement strict and isolated"],
  "front raise":["Stand feet shoulder-width apart, hold dumbbells in front of your thighs with palms facing down","With a slight elbow bend, raise one or both arms forward to shoulder height","Pause at the top, then lower slowly back to the start","Avoid swinging — this targets the anterior (front) deltoid"],
  "rear delt fly":["Stand and hinge forward at the hips about 45°, or use an incline bench","Hold dumbbells hanging down with a slight bend in your elbows","Raise both arms out to the sides in a wide arc — squeeze your rear delts and upper back at the top","Lower slowly back to the starting position — feel the stretch in your rear delts"],
  "face pull":["Attach a rope to a cable machine at approximately head height","Grip the rope with both hands and step back with arms extended","Pull the rope toward your face, driving your elbows back and out to the sides","Externally rotate your shoulders at the end — thumbs pointing back behind you","Slowly return to the start — great for shoulder health and rear delt development"],
  "upright row":["Stand feet shoulder-width apart, grip the barbell narrow with an overhand grip","Pull the bar straight up toward your chin, leading with your elbows","Elbows should travel up and flare out — keep the bar close to your body","Lower the bar slowly back to hip level under full control"],
  // ── TRICEPS ─────────────────────────────────────────────────────────────
  "tricep dip":["Support your bodyweight on parallel bars with arms straight","Keep your torso upright (vertical) to target the triceps","Lower your body by bending your elbows until they reach 90°","Press back up powerfully until your arms are fully extended — squeeze triceps at the top"],
  "skull crusher":["Lie flat on a bench, hold the EZ-bar or dumbbells directly above your forehead with arms extended","Keeping your upper arms stationary and vertical, bend your elbows to lower the weight toward your forehead","Stop just before the weight reaches your head, then extend your arms back to the top","Control the descent — do not rush this movement","Only your forearms should move — upper arms stay fixed and vertical"],
  "overhead tricep extension":["Stand or sit and hold a dumbbell with both hands, raising it overhead with arms extended","Keeping your upper arms close to your head, lower the dumbbell behind your head by bending your elbows","Feel the stretch in your triceps at the bottom of the movement","Extend your arms back overhead — squeeze your triceps hard at full extension"],
  "tricep pushdown":["Stand at the cable machine with a straight bar or rope attached to the high pulley","Grip the attachment and pin your elbows to your sides — keep them locked throughout","Push the bar or rope down until your arms are fully extended, squeezing your triceps hard","Slowly allow the weight to rise back up — control the movement throughout"],
  "close grip bench press":["Lie flat on the bench and grip the bar with hands about shoulder-width apart (narrower than a normal bench press)","Lower the bar to your lower chest keeping your elbows tucked close to your body","Press the bar back up — squeeze your triceps hard at full extension","The close grip shifts the focus from the chest to the triceps"],
  "diamond push up":["Get into push-up position but place your hands close together, forming a diamond with thumbs and index fingers","Keep your elbows tucked in close to your body throughout","Lower your chest toward your hands then press back up powerfully","This variation places maximum stress on the triceps"],
  // ── LEGS ────────────────────────────────────────────────────────────────
  "squat":["Stand with feet shoulder-width apart, toes pointing slightly outward","Brace your core and sit back and down as if lowering into a chair","Keep your chest tall and knees tracking over your toes — do not let them cave in","Lower until your thighs are at least parallel to the floor","Drive through your heels to stand, squeezing your glutes at the top"],
  "barbell squat":["Set the bar across your upper traps, grip outside shoulder-width, and unrack","Step back with feet shoulder-width apart and toes slightly out","Brace your core — break at the hips and knees simultaneously and descend until thighs are parallel","Drive powerfully through your heels to stand — knees track over toes throughout","Keep your chest tall and lower back neutral — no rounding"],
  "goblet squat":["Hold a dumbbell or kettlebell vertically at your chest with both hands","Stand with feet shoulder-width apart, toes turned slightly outward","Squat down keeping your chest tall — let your elbows brush inside your knees at the bottom","Drive through your heels to stand, squeezing your glutes at the top"],
  "leg press":["Sit in the leg press machine with your back and head firmly against the pad","Place feet shoulder-width on the platform, toes slightly turned out","Unlock the safety handles and lower the platform toward you until knees reach 90°","Do not let your lower back round off the pad at the bottom","Drive the platform away pressing through your heels until legs are nearly straight — do not lock out"],
  "lunge":["Stand tall with feet hip-width apart, hands on hips or holding dumbbells at your sides","Step forward with one leg and lower your back knee toward the floor","Keep your front shin vertical and torso upright — front knee should not travel past your toes","Push back off your front foot to return to the starting position","Alternate legs for each rep — focus on balance and control"],
  "walking lunge":["Stand tall holding dumbbells at your sides","Step forward with your right foot and lower your left knee toward the floor","Keep your torso upright and front shin vertical","Push through your right heel and step forward with your left foot to continue walking","Alternate legs continuously — keep the movement smooth and controlled"],
  "leg extension":["Sit in the leg extension machine and adjust the pad to rest just above your lower shins","Grip the handles and extend your legs until fully straight — squeeze your quads hard at the top","Hold the top position for a second, then lower slowly over 2–3 seconds","Stop just before the weights touch — keep constant tension on the quads"],
  "leg curl":["Lie face down on the leg curl machine — position the pad just above your heels","Grip the handles and curl your heels toward your glutes, squeezing your hamstrings at the top","Hold the contraction for a second at the top","Lower slowly over 2–3 seconds back to the start"],
  "hip thrust":["Sit on the floor with your upper back against a bench and a barbell across your hips","Plant your feet flat on the floor, hip-width apart, shins vertical","Drive your hips toward the ceiling by squeezing your glutes — create a straight line from knees to shoulders","Pause at the top for a full glute contraction","Lower your hips back down slowly and repeat — keep chin tucked throughout"],
  "glute bridge":["Lie flat on your back with knees bent and feet flat on the floor, hip-width apart","Drive your hips toward the ceiling by squeezing your glutes hard","Create a straight line from your knees to your shoulders at the top","Pause and squeeze hard, then lower slowly back to the floor"],
  "calf raise":["Stand with the balls of your feet on the edge of a step or raised platform","Let your heels drop below the platform level to get a full calf stretch","Rise up onto your toes as high as possible — squeeze your calves hard at the top","Lower slowly over 3 seconds — feel the full stretch at the bottom","Avoid bouncing — slow controlled reps build the most muscle"],
  "seated calf raise":["Sit at the seated calf raise machine with pads resting on your lower thighs","Place the balls of your feet on the platform, heels hanging off the edge","Push up onto your toes as high as possible — squeeze your calves hard at the top","Lower slowly — this seated variation particularly targets the soleus muscle"],
  // ── CORE ────────────────────────────────────────────────────────────────
  "plank":["Place forearms on the floor with elbows directly under your shoulders","Lift your body into a rigid straight line from head to heels — squeeze everything tight","Keep your hips level — do not let them sag down or pike up","Look slightly forward, breathe steadily and hold the position","Quality over duration — a perfect 30 seconds beats a sloppy 2 minutes"],
  "crunch":["Lie flat on your back with knees bent and feet flat on the floor","Place hands lightly behind your head — do not pull your neck forward","Engage your abs and curl your upper body upward, bringing your chest toward your knees","Pause at the top with a full ab contraction, then lower slowly","Focus on the contraction — a short intense range of motion is all you need"],
  "sit up":["Lie flat with knees bent and feet flat on the floor","Cross arms over your chest or place hands behind your head","Engage your core and lift your torso all the way up toward your knees","Lower slowly back to the floor — keep the movement controlled throughout"],
  "leg raise":["Lie flat on your back with legs extended and hands under your glutes for support","Keep your legs straight and raise them toward the ceiling until they reach 90°","Lower your legs slowly — stop just before they touch the floor to keep tension","Avoid arching your lower back — press it into the floor throughout"],
  "hanging leg raise":["Hang from a pull-up bar with an overhand grip, body fully extended","Keep your legs straight and raise them up to hip height or higher","Avoid swinging — control the movement entirely with your abs","Lower your legs slowly, stopping just before the dead hang position"],
  "russian twist":["Sit with knees bent and feet slightly off the floor, or flat for an easier version","Lean back to about 45° and hold your hands or a weight in front of you","Rotate your torso side to side, bringing your hands toward the floor on each side","Keep your core tight and movements controlled — feel the obliques working"],
  "mountain climber":["Get into a straight-arm plank with hands directly under your shoulders","Drive your right knee toward your chest, then quickly switch — left knee in as right goes back","Keep your hips low and your core tight throughout — don't let them rise up","Maintain a quick alternating pace while holding full core tension"],
  "bicycle crunch":["Lie flat with hands behind your head and legs raised off the floor","Bring your right elbow and left knee toward each other while extending your right leg straight","Rotate to the other side in a smooth pedaling motion — left elbow to right knee","Keep your lower back pressed into the floor throughout"],
  "cable crunch":["Kneel in front of a high cable machine with a rope attachment","Hold the rope beside your head and keep your hips completely stationary","Crunch downward by contracting your abs — bring your elbows toward your knees","Pause at the bottom with a full contraction then slowly return to the start"],
  // ── FULL BODY / CARDIO ──────────────────────────────────────────────────
  "burpee":["Stand with feet shoulder-width apart","Drop your hands to the floor and jump your feet back to a plank position","Perform a push-up, then jump your feet back toward your hands","Explode upward, jumping with your arms raised overhead","Land softly and immediately go into the next rep"],
  "kettlebell swing":["Stand feet hip-width apart, kettlebell on the floor in front of you","Hinge at the hips to grip the kettlebell — back flat, chest up","Swing the kettlebell back between your legs to load your hips and hamstrings","Drive your hips forward explosively to swing the bell to shoulder height","Let the bell swing back down and immediately load your hips for the next rep"],
  "box jump":["Stand facing a box, feet shoulder-width apart","Bend your knees and swing your arms back to load up","Explode upward and forward, pulling your knees toward your chest","Land softly on top of the box with knees slightly bent to absorb the impact","Step back down carefully and reset for the next rep"],
  "jump squat":["Stand feet shoulder-width apart, toes slightly out","Descend into a squat until thighs reach parallel — arms swinging back","Explode upward through the balls of your feet, leaving the floor","Land softly with knees slightly bent to absorb the impact","Immediately descend into the next squat rep"],
};

function getExerciseInstructions(ex) {
  // 1. Use DB instructions if present
  if (ex.instructions) {
    const parsed = ex.instructions.split(/\n|;/).map(s => s.trim()).filter(Boolean);
    if (parsed.length >= 2) return parsed;
  }

  // 2. Name-based lookup (normalized)
  const name = (ex.name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (EXERCISE_INSTRUCTIONS_MAP[name]) return EXERCISE_INSTRUCTIONS_MAP[name];

  // Partial match — key contains all words of name, or name contains key
  const keys = Object.keys(EXERCISE_INSTRUCTIONS_MAP);
  const nameWords = name.split(' ').filter(w => w.length > 2);
  let bestKey = null;
  let bestScore = 0;
  for (const key of keys) {
    const keyWords = key.split(' ');
    const hits = nameWords.filter(w => keyWords.includes(w)).length;
    if (hits > bestScore) { bestScore = hits; bestKey = key; }
  }
  if (bestScore >= 2) return EXERCISE_INSTRUCTIONS_MAP[bestKey];

  // 3. Muscle-group fallback
  const m = (ex.muscles || '').toLowerCase();
  const e = (ex.equipment || '').toLowerCase();
  if (m.includes('bicep')) return [
    "Stand or sit in a stable position, gripping the weight with palms facing up",
    "Pin your elbows close to your sides — keep them stationary throughout",
    "Curl the weight upward by bending at the elbow, squeezing your bicep at the top",
    "Lower slowly over 2–3 seconds back to full extension",
    "Avoid swinging — the movement should be fully controlled",
  ];
  if (m.includes('tricep')) return [
    "Set up with your upper arm stationary in a fixed position",
    "Begin with your elbow bent and the weight loaded on your tricep",
    "Extend your arm fully — squeeze your tricep hard at full extension",
    "Slowly return to the starting position, feeling the stretch in your tricep",
  ];
  if (m.includes('chest') || m.includes('pec')) return [
    "Set up in a stable position with shoulder blades retracted and chest tall",
    "Lower the weight in a controlled arc — feel the stretch across your chest at the bottom",
    "Press or push back to the starting position, squeezing your chest at the top",
    "Exhale on the effort, inhale as you return — maintain controlled breathing throughout",
  ];
  if (m.includes('back') || m.includes('lat')) return [
    "Set up and retract your shoulder blades to initiate the movement",
    "Pull by driving your elbows back toward your hips — not just with your arms",
    "Squeeze your back muscles hard at the point of full contraction",
    "Return to the starting position slowly — feel the stretch in your lats",
  ];
  if (m.includes('shoulder') || m.includes('delt')) return [
    "Set up in a stable position with shoulders relaxed and core braced",
    "Execute the movement in a controlled deliberate arc — quality over weight",
    "Squeeze your deltoids at the peak of the movement",
    "Return to the starting position slowly, maintaining muscle tension throughout",
  ];
  if (m.includes('quad') || m.includes('hamstring') || m.includes('glute') || m.includes('leg')) return [
    "Set up with feet in the appropriate position — core braced, neutral spine",
    "Lower yourself in a controlled manner — knees tracking over your toes",
    "Drive through your heels to return to the starting position",
    "Squeeze your glutes and quads at the top of each rep",
  ];
  if (m.includes('calf')) return [
    "Position the balls of your feet on the platform — heels free to drop",
    "Lower your heels for a full calf stretch before each rep",
    "Rise as high as possible onto your toes — squeeze your calves hard at the top",
    "Lower slowly over 3 seconds to maximize time under tension",
  ];
  if (m.includes('core') || m.includes('ab')) return [
    "Engage your core fully before initiating the movement",
    "Exhale as you contract your abs during the crunch or exertion phase",
    "Focus on quality contractions rather than speed or momentum",
    "Return to the starting position slowly to maintain constant tension",
  ];
  return [
    "Set up in a stable, balanced position before starting",
    "Engage your core and maintain good posture throughout the movement",
    "Perform the exercise through the full range of motion in a controlled manner",
    "Exhale during the exertion phase and inhale on the return",
    "Focus on quality contractions — avoid using momentum or swinging",
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// ── NEW INNER PAGE: EXERCISE DETAIL ──────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function ExercisePage({ exercise, onBack, onComplete, workoutElapsed=0, workoutFmt, onAutoStartWorkout }) {
  const exScrollRef = useScrollPos("exercise-" + (exercise?.name||""));
  const ex = exercise ? normaliseExercise(exercise) : normaliseExercise(EXERCISES[0]);

  const [resolvedVideoUrl, setResolvedVideoUrl] = useState(ex.videoUrl || null);
  const [resolvedHlsUrl,   setResolvedHlsUrl]   = useState(ex.hlsUrl || null);
  const [videoLoading, setVideoLoading] = useState(!!(ex.ymoveId || ex.name));
  const [resumePos, setResumePos] = useState(0);
  useEffect(()=>{
    setResolvedVideoUrl(ex.videoUrl || null); // show stored URL immediately while fresh one loads
    setResolvedHlsUrl(ex.hlsUrl || null);
    // Need either a ymoveId (fast path) or a name (name-search fallback) to fetch a video
    if (!ex.ymoveId && !ex.name) { setVideoLoading(false); return; }
    const token = getAuthToken();
    if (!token) { setVideoLoading(false); return; }
    // Check in-memory cache before hitting the network (CDN URLs are valid for 48 h)
    const cacheKey = ex.ymoveId || ex.name;
    const cached = _videoUrlCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < VIDEO_TTL_MS) {
      if (cached.videoUrl) setResolvedVideoUrl(cached.videoUrl);
      if (cached.hlsUrl)   setResolvedHlsUrl(cached.hlsUrl);
      setVideoLoading(false);
      return;
    }
    setVideoLoading(true);
    // Restore resume position — use ymoveId if available, otherwise DB id
    const progressKey = ex.ymoveId || ex.id;
    try {
      const saved = JSON.parse(localStorage.getItem('vtrx_vidprog_' + progressKey) || 'null');
      if (saved?.pos > 5) setResumePos(saved.pos);
    } catch(_e){}
    // Fast path: ymoveId is known — fetch directly
    // Slow path: ymoveId is null — search ymove by name; backend back-fills ymoveId for next time
    const endpoint = ex.ymoveId
      ? `/workouts/exercise-video/${ex.ymoveId}`
      : `/workouts/exercise-video?name=${encodeURIComponent(ex.name)}`;
    apiCall(endpoint)
      .then(d => {
        const { videoUrl: vUrl, hlsUrl: hUrl } = d?.data || {};
        console.log(`[video] ymoveId=${ex.ymoveId||'null'} name="${ex.name}" videoUrl=${vUrl||'null'} hlsUrl=${hUrl||'null'}`);
        if (vUrl) setResolvedVideoUrl(vUrl);
        if (hUrl) setResolvedHlsUrl(hUrl);
        if (vUrl || hUrl) _videoUrlCache.set(cacheKey, { videoUrl: vUrl||null, hlsUrl: hUrl||null, cachedAt: Date.now() });
        if (!vUrl && !hUrl) console.warn(`[video] No URL for "${ex.name}" — check YMOVE_API_KEY in Railway`);
      })
      .catch(err => { console.error(`[video] fetch failed for "${ex.name}":`, err); setResolvedHlsUrl(null); })
      .finally(()=>{ setVideoLoading(false); });
  }, [ex.ymoveId, ex.name, ex.videoUrl, ex.hlsUrl]);

  const [sets, setSets] = useState([{reps:"",weight:"",done:false},{reps:"",weight:"",done:false}]);
  const MIN_SETS = 2; // first 2 sets cannot be deleted
  const [started, setStarted] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(true);
  const [instructOpen, setInstructOpen] = useState(false);
  const [activeSet, setActiveSet] = useState(0);
  const [restTimer, setRestTimer] = useState(null);
  const [restCount, setRestCount] = useState(0);
  const timerRef = useRef(null);

  const [isPortrait,      setIsPortrait]      = useState(false);
  const [panelOpen,       setPanelOpen]       = useState(false);
  const [portraitPlaying, setPortraitPlaying] = useState(false);
  const dragRef        = useRef({ startY: 0, isDismissing: false, decided: false });
  const panelDragYRef  = useRef(0);
  const panelRef       = useRef(null);
  const swipeUpStartY  = useRef(0);
  const videoPlayerRef = useRef(null);

  // Attach native (non-passive) touch listeners to the panel so we can call
  // preventDefault() when we've decided the gesture is a dismiss swipe.
  // JSX onTouchMove handlers are passive in most browsers and can't preventDefault.
  useEffect(() => {
    if (!isPortrait || !panelOpen || !panelRef.current) return;
    const panel   = panelRef.current;
    const scrollEl = exScrollRef.current;

    const onStart = (e) => {
      const rect = panel.getBoundingClientRect();
      const offsetInPanel = e.touches[0].clientY - rect.top;
      dragRef.current = {
        startY: e.touches[0].clientY,
        isDismissing: false,
        decided: false,
        fromPillArea: offsetInPanel < 72,  // pill + label region — always dismissible
      };
      panel.style.transition = 'none';
    };

    const onMove = (e) => {
      const d = dragRef.current;
      const dy = e.touches[0].clientY - d.startY;
      if (!d.decided) {
        if (Math.abs(dy) < 6) return;                         // wait until direction is clear
        const scrollTop = scrollEl?.scrollTop ?? 0;
        // Dismiss if: pulled from pill area OR dragging down while already at scroll top
        d.isDismissing = dy > 0 && (d.fromPillArea || scrollTop <= 0);
        d.decided = true;
      }
      if (d.isDismissing) {
        e.preventDefault();                                    // prevent scroll while dismissing
        const clampedDy = Math.max(0, dy);
        panelDragYRef.current = clampedDy;
        panel.style.transform = `translateY(${clampedDy}px)`;
      }
    };

    const onEnd = () => {
      const d = dragRef.current;
      if (!d.decided) { panel.style.transition = 'transform 0.38s cubic-bezier(0.32,0.72,0,1)'; return; }
      const dy = panelDragYRef.current;
      panelDragYRef.current = 0;
      panel.style.transition = 'transform 0.38s cubic-bezier(0.32,0.72,0,1)';
      if (d.isDismissing && dy > 60) {
        panel.style.transform = 'translateY(100%)';
        setTimeout(() => setPanelOpen(false), 380);
      } else {
        panel.style.transform = 'translateY(0px)';
      }
    };

    panel.addEventListener('touchstart', onStart, { passive: true });
    panel.addEventListener('touchmove',  onMove,  { passive: false });
    panel.addEventListener('touchend',   onEnd,   { passive: true  });
    return () => {
      panel.removeEventListener('touchstart', onStart);
      panel.removeEventListener('touchmove',  onMove);
      panel.removeEventListener('touchend',   onEnd);
    };
  }, [isPortrait, panelOpen]);

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

  const instructions = getExerciseInstructions(ex);

  const aiTips = [
    { icon:"clock", label:"Rest Time", value:"60–90 seconds between sets", color:"#00A3FF" },
    { icon:"target", label:"Focus",     value:"Control the weight on the way down", color:"#22C55E" },
    { icon:"muscle", label:"Tip",       value:"Keep your feet planted for stability", color:"#F97316" },
    { icon:"lightbulb", label:"Beginner",  value:"Start light — master form before adding weight", color:"#8B5CF6" },
  ];

  const progressPct = (completedSets / sets.length) * 100;


  const exSubtitle = [ex.muscles, ex.equipment].filter(Boolean).join(' · ');

  const videoProps = {
    videoUrl: resolvedVideoUrl,
    hlsUrl: resolvedHlsUrl,
    videoUrlLoading: videoLoading,
    thumbnailUrl: ex.thumbnailUrl || ex.img || "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=400&q=70",
    exerciseName: ex.name,
    initialPositionSecs: resumePos,
    onPortraitDetected: (portrait) => { setIsPortrait(portrait); setPortraitPlaying(false); }, // reset on layout switch
    onProgress: (pos, dur) => {
      if (ex.ymoveId || ex.id) {
        const KEY = 'vtrx_vidprog_' + (ex.ymoveId || ex.id);
        try { localStorage.setItem(KEY, JSON.stringify({ pos: Math.floor(pos), dur: Math.floor(dur) })); } catch(_e){}
      }
    },
    onVideoComplete: () => { if (onAutoStartWorkout) onAutoStartWorkout(); setPortraitPlaying(false); },
  };

  // Shared panel body used in both portrait and landscape layouts
  const innerContent = (
    <>
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
        <button onClick={addSet} style={{ width:"100%",padding:"12px 0",borderRadius:12,background:"transparent",border:`1.5px dashed ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888888",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginTop:4,transition:"all 0.2s" }}>
          <span style={{ fontSize:18,lineHeight:1 }}>+</span> Add Set
        </button>
      </div>
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
    </>
  );

  const cta = (
    <div style={{ position:"absolute",bottom:0,left:0,right:0,padding:"12px 16px 28px",background:`linear-gradient(180deg,transparent 0%,${BG} 30%)`,paddingTop:20 }}>
      {!allDone ? (
        <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
          {(()=>{
            const ready = started && canComplete(activeSet) && activeSet < sets.length && !sets[activeSet].done;
            const btnBg = !started ? `linear-gradient(135deg,${PRIMARY},#0068CC)` : ready ? `linear-gradient(135deg,${PRIMARY},#0068CC)` : "linear-gradient(135deg,#1a1a1a,#222)";
            return (
              <button
                onClick={()=>{ if(!started) setStarted(true); else if(ready) markSetDone(activeSet); }}
                style={{ width:"100%",padding:"14px 0",borderRadius:50,border:ready||!started?`none`:`1px solid ${BORDER}`,background:btnBg,fontFamily:FONT,fontWeight:800,fontSize:14,color:ready||!started?"#fff":"#444",letterSpacing:1,cursor:ready||!started?"pointer":"not-allowed",display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:ready||!started?`0 4px 28px ${PRIMARY}55`:"none",transition:"all 0.2s" }}>
                {!started
                  ? <><svg width="13" height="13" viewBox="0 0 13 13" fill="white"><polygon points="0,0 13,6.5 0,13"/></svg> START EXERCISE</>
                  : <>
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
        <button onClick={()=>{ if(onComplete) onComplete(sets.filter(s=>s.done)); onBack(); }} style={{ width:"100%",padding:"16px 0",borderRadius:50,border:"none",background:"linear-gradient(135deg,#22C55E,#16A34A)",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",boxShadow:"0 4px 24px rgba(34,197,94,0.5)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" style={{display:"inline",marginRight:6,verticalAlign:"middle"}}><polyline points="20 6 9 17 4 12"/></svg>
          EXERCISE COMPLETE — NEXT
        </button>
      )}
    </div>
  );

  // ── PORTRAIT LAYOUT: video fills screen, content panel slides from bottom ─────
  if (isPortrait && resolvedVideoUrl) {
    const openPanel = () => {
      if (panelRef.current) {
        panelRef.current.style.transition = 'transform 0.38s cubic-bezier(0.32,0.72,0,1)';
        panelRef.current.style.transform  = 'translateY(0px)';
      }
      setPanelOpen(true);
    };

    return (
      <div style={{ position:"absolute",inset:0,background:"#000",overflow:"hidden" }}>

        {/* Full-screen portrait video behind everything */}
        <VideoPlayer ref={videoPlayerRef} {...videoProps} fillContainer portraitMode />

        {/* Play button — true screen center, only when video not yet playing */}
        {!portraitPlaying && (
          <div
            style={{ position:"absolute", top:"50%", left:"50%",
                     transform:"translate(-50%,-50%)",
                     zIndex:16, cursor:"pointer" }}
            onClick={() => {
              videoPlayerRef.current?.togglePlay();
              setPortraitPlaying(true);
            }}
          >
            <div style={{ width:72, height:72, borderRadius:"50%", background:PRIMARY,
                          border:"2px solid rgba(255,255,255,0.3)", display:"flex",
                          alignItems:"center", justifyContent:"center",
                          boxShadow:`0 0 40px ${PRIMARY}99` }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>
            </div>
          </div>
        )}

        {/* Back button + title — always visible at top */}
        <div style={{ position:"absolute",top:0,left:0,right:0,zIndex:20,padding:"50px 18px 24px",background:"linear-gradient(180deg,rgba(0,0,0,0.75) 0%,transparent 100%)",pointerEvents:"none" }}>
          <div style={{ display:"flex",alignItems:"center",pointerEvents:"all" }}>
            <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:"rgba(0,0,0,0.5)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",border:"1px solid rgba(255,255,255,0.15)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#fff",fontSize:20,flexShrink:0 }}>‹</button>
            <div style={{ flex:1,textAlign:"center",padding:"0 12px" }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff",textShadow:"0 1px 6px rgba(0,0,0,0.7)" }}>{ex.name}</div>
              {exSubtitle && <div style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.7)",marginTop:3 }}>{exSubtitle}</div>}
            </div>
            <div style={{ width:36 }}/>
          </div>
        </div>

        {/* When panel is hidden: full-screen swipe-up zone to restore it */}
        {!panelOpen && (
          <div
            style={{ position:"absolute",inset:0,zIndex:14 }}
            onTouchStart={(e) => { swipeUpStartY.current = e.touches[0].clientY; }}
            onTouchEnd={(e) => {
              const dy = swipeUpStartY.current - e.changedTouches[0].clientY;
              if (dy > 40) openPanel(); // upward swipe anywhere on screen
            }}
          >
            {/* Subtle "swipe up" hint at bottom */}
            <div style={{ position:"absolute",bottom:44,left:0,right:0,display:"flex",flexDirection:"column",alignItems:"center",gap:6,pointerEvents:"none" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
              <div style={{ fontFamily:FONT,fontSize:11,color:"rgba(255,255,255,0.4)",letterSpacing:1.5 }}>SWIPE UP FOR DETAILS</div>
            </div>
          </div>
        )}

        {/* Content panel — native touch listeners (see useEffect) handle the drag */}
        <div
          ref={panelRef}
          style={{
            position:"absolute",bottom:0,left:0,right:0,zIndex:15,
            height:"68%",
            background:"linear-gradient(180deg,rgba(8,12,26,0.96) 0%,rgba(8,12,26,0.99) 40%)",
            backdropFilter:"blur(20px)",
            WebkitBackdropFilter:"blur(20px)",
            borderRadius:"24px 24px 0 0",
            transform: panelOpen ? "translateY(0px)" : "translateY(100%)",
            transition:"transform 0.38s cubic-bezier(0.32,0.72,0,1)",
            display:"flex",flexDirection:"column",
            boxShadow:"0 -20px 60px rgba(0,0,0,0.7)",
            willChange:"transform",
          }}
        >
          {/* Pill handle — visual affordance only; the whole panel is draggable */}
          <div style={{ paddingTop:12,paddingBottom:10,display:"flex",flexDirection:"column",alignItems:"center",gap:5,flexShrink:0,userSelect:"none",pointerEvents:"none" }}>
            <div style={{ width:44,height:5,borderRadius:3,background:"rgba(255,255,255,0.35)" }}/>
            <div style={{ fontFamily:FONT,fontSize:10,color:"rgba(255,255,255,0.3)",letterSpacing:1.5 }}>SWIPE DOWN TO HIDE</div>
          </div>

          {/* Scrollable content */}
          <div ref={exScrollRef} style={{ flex:1,overflowY:"auto",paddingBottom:110 }}>
            <div style={{ padding:"4px 16px 0" }}>{innerContent}</div>
          </div>

          {cta}
        </div>
      </div>
    );
  }

  // ── LANDSCAPE LAYOUT (default) ────────────────────────────────────────────
  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* ── HEADER ── */}
      <div style={{ padding:"50px 18px 10px",display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexShrink:0 }}>
        <button onClick={onBack} style={{ width:36,height:36,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:"#fff",fontSize:20,marginTop:2 }}>‹</button>
        <div style={{ flex:1,textAlign:"center",padding:"0 12px" }}>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff" }}>{ex.name}</div>
          {exSubtitle && <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:3 }}>{exSubtitle}</div>}
        </div>
        <div style={{ width:36 }}/>
      </div>

      {/* ── SCROLL BODY ── */}
      <div ref={exScrollRef} style={{ flex:1,overflowY:"auto",paddingBottom:100 }}>
        <VideoPlayer {...videoProps} />
        <div style={{ padding:"16px 16px 0" }}>{innerContent}</div>
      </div>

      {cta}
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

function PerfIcon({ type, color }) {
  const s = { width:"16", height:"16", viewBox:"0 0 24 24", fill:"none", stroke:color, strokeWidth:"2" };
  if (type==="check") return <svg {...s}><polyline points="20 6 9 17 4 12"/></svg>;
  if (type==="bolt")  return <svg {...s}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
  if (type==="clock") return <svg {...s}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
  if (type==="heart") return <svg {...s}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>;
  if (type==="smile") return <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}

function AISummaryPage({ energyKey, logId, onBack }) {
  const { dark } = useTheme();
  const { isPremium, user: currentUser } = useUser();
  const aiScrollRef = useScrollPos("ai-summary");
  const scrollRef = useRef(null);

  // ── Onboarding analysis state (when no logId) ──
  const [onboardingData, setOnboardingData] = useState(null);
  const [onboardingLoading, setOnboardingLoading] = useState(!logId);
  const [onboardingTwText, setOnboardingTwText] = useState("");
  const [onboardingTwDone, setOnboardingTwDone] = useState(false);

  useEffect(() => {
    if (logId) return;
    setOnboardingLoading(true);
    apiCall('/ai/onboarding-analysis')
      .then(res => {
        if (res?.data) setOnboardingData(res.data);
      })
      .catch(() => {})
      .finally(() => setOnboardingLoading(false));
  }, [logId]);

  // Typewriter for onboarding summary
  useEffect(() => {
    if (logId || onboardingLoading) return;
    const text = onboardingData?.workoutSummary || '';
    if (!text) return;
    setOnboardingTwText(''); setOnboardingTwDone(false);
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setOnboardingTwText(text.slice(0, i));
      if (i >= text.length) { clearInterval(iv); setOnboardingTwDone(true); }
    }, 16);
    return () => clearInterval(iv);
  }, [logId, onboardingLoading, onboardingData]);

  // ── Polling state ──
  const [summaryData, setSummaryData] = useState(null);
  const [loading, setLoading] = useState(!!logId);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [pollStatus, setPollStatus] = useState("Analyzing your workout data");
  const [retryCount, setRetryCount] = useState(0);
  const [dotCount, setDotCount] = useState(0);

  // ── UI state ──
  const [tab, setTab] = useState("recap");
  const [postMood, setPostMood] = useState(null);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [barReady, setBarReady] = useState(false);
  const [expandedEx, setExpandedEx] = useState(null);
  const [twText, setTwText] = useState("");
  const [twDone, setTwDone] = useState(false);

  // Dots animation while loading
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setDotCount(d => (d + 1) % 4), 500);
    return () => clearInterval(t);
  }, [loading]);

  // Poll API
  const POLL_STATUSES = [
    "Analyzing your workout data",
    "Processing performance metrics",
    "Building your personalized report",
    "Almost there, finalizing insights",
  ];
  useEffect(() => {
    if (!logId) { setLoading(false); return; }
    let attempts = 0;
    let cancelled = false;
    setLoading(true);
    setFetchFailed(false);
    const poll = async () => {
      if (cancelled) return;
      setPollStatus(POLL_STATUSES[attempts < 4 ? 0 : attempts < 7 ? 1 : attempts < 10 ? 2 : 3]);
      try {
        const res = await apiCall(`/workouts/ai-summary/${logId}`);
        if (cancelled) return;
        if (res && res.success && res.data && res.data.summary) {
          setSummaryData(res.data.summary);
          setLoading(false);
          return;
        }
      } catch (_e) { /* 202 or other — keep polling */ }
      attempts++;
      if (attempts >= 12) { setLoading(false); setFetchFailed(true); return; }
      setTimeout(poll, 2500);
    };
    poll();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logId, retryCount]);

  // Trigger bar animation on tab change
  useEffect(() => {
    setBarReady(false);
    const t = setTimeout(() => setBarReady(true), 220);
    return () => clearTimeout(t);
  }, [tab]);

  // Typewriter for AI summary text
  const recap = summaryData?.recap || {};
  const aiMainText = summaryData?.summary || "Great effort today! Based on your mood check-in, I adapted your session intensity. Your form held strong through all sets — consistency like this compounds over time.";
  const aiCoachText = recap.coachingInsights || "";

  useEffect(() => {
    if (loading) return;
    setTwText("");
    setTwDone(false);
    let i = 0;
    const full = aiMainText;
    const iv = setInterval(() => {
      i++;
      setTwText(full.slice(0, i));
      if (i >= full.length) { clearInterval(iv); setTwDone(true); }
    }, 18);
    return () => clearInterval(iv);
  }, [loading, aiMainText]);

  const cardBg = "linear-gradient(145deg,#0a0f1e,#141b35)";
  const cardBorder = `1.5px solid ${PRIMARY}33`;
  const onScroll = (e) => setHeaderCollapsed(e.target.scrollTop > 60);

  const postMoods = [
    { key:"drained", label:"Drained", color:"#EF4444" },
    { key:"okay",    label:"Okay",    color:"#F97316" },
    { key:"good",    label:"Good",    color:"#22C55E" },
    { key:"pumped",  label:"Pumped",  color:PRIMARY   },
  ];

  const muscleColors = { Chest:"#60A5FA", Back:"#34D399", Shoulders:"#FBBF24", Arms:"#F87171", Legs:"#A78BFA", Core:"#FB923C", Glutes:"#F472B6" };
  const getMuscleColor = (name) => muscleColors[name] || "#94A3B8";

  const metricsData = recap.metrics || {};
  const metricCards = [
    { key:"completionRate",  label:"Completion Rate",  val:metricsData.completionRate  != null ? `${metricsData.completionRate}%` : "90%",  color:"#22C55E" },
    { key:"intensityScore",  label:"Intensity Score",  val:metricsData.intensityScore  != null ? `${metricsData.intensityScore}`  : "72",   color:PRIMARY   },
    { key:"volumeLifted",    label:"Volume Lifted",    val:metricsData.volumeLifted    != null ? `${metricsData.volumeLifted}kg`  : "1,890kg",color:"#F97316" },
    { key:"moodAlignment",   label:"Mood Alignment",   val:metricsData.moodAlignment   != null ? `${metricsData.moodAlignment}%` : "88%",  color:"#8B5CF6" },
  ];
  const overallScore = metricsData.intensityScore != null ? Math.round(metricsData.intensityScore) : 83;
  const exerciseBreakdown = recap.exerciseBreakdown || [];
  const muscleGroups = recap.muscleGroups || [];
  const achievements = recap.achievements || [];
  const keyInsights = summaryData?.keyInsights || [];
  const recommendations = summaryData?.recommendations || [];
  const moodAnalysis = recap.moodAnalysis || null;

  const PaywallCard = ({ title, description }) => (
    <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"32px 20px",textAlign:"center",margin:"8px 0" }}>
      <div style={{ width:64,height:64,borderRadius:"50%",background:"rgba(245,158,11,0.12)",border:"1.5px solid rgba(245,158,11,0.3)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px" }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      </div>
      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff",marginBottom:8 }}>{title}</div>
      <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.6,marginBottom:20 }}>{description}</div>
      <button onClick={()=>openPaymentSheet("monthly")} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:"linear-gradient(135deg,#F59E0B,#D97706)",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",letterSpacing:1,boxShadow:"0 4px 20px rgba(245,158,11,0.35)",transition:"all 0.2s" }}>UPGRADE TO PRO</button>
    </div>
  );

  // ── Onboarding analysis view (no logId = accessed from home, not post-workout) ──
  if (!logId) {
    const firstName = currentUser?.name?.split(' ')[0] || 'there';
    const hasAnalysis = onboardingData?.workoutSummary;
    return (
      <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
        {/* Header */}
        <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
          <button onClick={onBack} style={{ width:38,height:38,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:"#fff" }}>VTRXAI Analysis</div>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:2 }}>Your Personalised Coaching Plan</div>
          </div>
          <div style={{ width:38 }}/>
        </div>

        <div ref={scrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 40px" }}>
          {onboardingLoading ? (
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",paddingTop:80,gap:16 }}>
              <div style={{ width:64,height:64,borderRadius:"50%",background:"linear-gradient(135deg,#7C3AED,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 32px rgba(124,58,237,0.5)",animation:"glow 2s ease infinite" }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </div>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff" }}>Preparing your analysis{".".repeat(dotCount)}</div>
              <div style={{ fontFamily:FONT,fontSize:13,color:"#666",textAlign:"center",lineHeight:1.6,maxWidth:260 }}>Your AI coaching plan is being generated based on your profile. This only takes a moment.</div>
            </div>
          ) : hasAnalysis ? (
            <>
              {/* AI Coach Card */}
              <div style={{ background:"linear-gradient(145deg,#0a0f1e,#141b35)",borderRadius:22,border:`1.5px solid ${PRIMARY}33`,padding:"22px 20px",marginBottom:14,boxShadow:"0 0 40px rgba(109,40,217,0.15)" }}>
                <div style={{ display:"flex",gap:12,alignItems:"center",marginBottom:16 }}>
                  <div style={{ width:48,height:48,borderRadius:"50%",background:"linear-gradient(135deg,#7C3AED,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 0 20px rgba(124,58,237,0.5)",animation:"glow 3s ease infinite" }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  </div>
                  <div>
                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff" }}>VTRX AI Coach</div>
                    <div style={{ fontFamily:FONT,fontSize:11,color:"#8B5CF6",marginTop:2 }}>Personalised for {firstName}</div>
                  </div>
                  <div style={{ marginLeft:"auto",background:`${PRIMARY}22`,border:`1.5px solid ${PRIMARY}55`,borderRadius:20,padding:"5px 12px" }}>
                    <span style={{ fontFamily:FONT,fontWeight:800,fontSize:10,color:PRIMARY,letterSpacing:1 }}>FREE</span>
                  </div>
                </div>
                <div style={{ fontFamily:FONT,fontSize:13.5,color:"#ccc",lineHeight:1.75 }}>{onboardingTwText}{!onboardingTwDone && <span style={{ opacity:0.6 }}>▋</span>}</div>
              </div>

              {/* Goal summary chips */}
              {currentUser?.goal && (
                <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:14 }}>
                  {[
                    { label: currentUser.goal, color: PRIMARY },
                    currentUser.fitnessLevel && { label: currentUser.fitnessLevel, color: "#8B5CF6" },
                    currentUser.daysPerWeek  && { label: `${currentUser.daysPerWeek} days/week`, color: "#22C55E" },
                  ].filter(Boolean).map((chip, i) => (
                    <div key={i} style={{ background:`${chip.color}18`,border:`1px solid ${chip.color}44`,borderRadius:20,padding:"5px 12px" }}>
                      <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:chip.color }}>{chip.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Upgrade CTA */}
              {!isPremium && (
                <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"22px 20px",textAlign:"center",marginBottom:14 }}>
                  <div style={{ width:52,height:52,borderRadius:"50%",background:"rgba(245,158,11,0.12)",border:"1.5px solid rgba(245,158,11,0.3)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px" }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  </div>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff",marginBottom:8 }}>Get Per-Workout AI Coaching</div>
                  <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.6,marginBottom:20 }}>
                    Upgrade to Pro and get a detailed AI analysis after every single workout — form feedback, intensity score, and personalised next-session recommendations.
                  </div>
                  <button onClick={()=>openPaymentSheet("monthly")} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:"linear-gradient(135deg,#F59E0B,#D97706)",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",letterSpacing:1,boxShadow:"0 4px 20px rgba(245,158,11,0.35)" }}>
                    UPGRADE TO PRO
                  </button>
                </div>
              )}
            </>
          ) : (
            /* No workout logged yet */
            <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"40px 24px",textAlign:"center",marginTop:20 }}>
              <div style={{ width:64,height:64,borderRadius:"50%",background:"rgba(124,58,237,0.12)",border:"1.5px solid rgba(124,58,237,0.35)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px" }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              </div>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff",marginBottom:10 }}>No Workouts Logged Yet</div>
              <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.7,marginBottom:24 }}>
                Complete your first workout to unlock your personalised VTRX analysis — strength scores, progress tracking, and coaching insights all in one place.
              </div>
              <button
                onClick={() => onBack()}
                style={{ padding:"13px 32px",borderRadius:50,background:"linear-gradient(135deg,#7C3AED,#4C1D95)",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",letterSpacing:0.8,boxShadow:"0 4px 20px rgba(124,58,237,0.35)" }}
              >
                START A WORKOUT
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Loading screen ──
  if (loading) {
    return (
      <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:FONT }}>
        <div style={{ width:80,height:80,borderRadius:"50%",background:"linear-gradient(135deg,#7C3AED,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 40px rgba(124,58,237,0.5)",animation:"glow 2s ease infinite",marginBottom:28 }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
        <div style={{ fontWeight:800,fontSize:16,color:"#fff",marginBottom:10,letterSpacing:0.5 }}>VTRX Coach is analyzing your workout{".".repeat(dotCount)}</div>
        <div style={{ fontSize:13,color:"#888" }}>{pollStatus}{".".repeat(dotCount)}</div>
      </div>
    );
  }

  // ── Timeout screen ──
  if (fetchFailed) {
    return (
      <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:FONT,padding:32 }}>
        <div style={{ width:64,height:64,borderRadius:"50%",background:"linear-gradient(135deg,#7C3AED,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:24 }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
        <div style={{ fontWeight:800,fontSize:17,color:"#fff",marginBottom:10,textAlign:"center" }}>Still generating...</div>
        <div style={{ fontSize:13,color:"#888",textAlign:"center",marginBottom:32,maxWidth:260 }}>Your AI summary is taking longer than usual. Keep waiting or view a default recap.</div>
        <div style={{ display:"flex",gap:12 }}>
          <button onClick={()=>setRetryCount(c=>c+1)}
            style={{ padding:"12px 24px",borderRadius:50,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",cursor:"pointer" }}>
            Keep Waiting
          </button>
          <button onClick={()=>setFetchFailed(false)}
            style={{ padding:"12px 24px",borderRadius:50,background:"#1a1a1a",border:"1px solid #333",fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",cursor:"pointer" }}>
            Use Default
          </button>
        </div>
      </div>
    );
  }

  const workoutName = summaryData?.name || "Workout Recap";
  const workoutDate = summaryData?.date ? new Date(summaryData.date).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"}) : new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});
  const workoutType = summaryData?.type || "STRENGTH";
  const workoutCalories = summaryData?.calories || metricsData.caloriesBurned || "—";
  const workoutDuration = summaryData?.duration || metricsData.duration || "—";
  const workoutMood = summaryData?.mood || "—";

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* ── COLLAPSIBLE HEADER ── */}
      <div style={{ flexShrink:0,background:BG,transition:"all 0.3s ease",overflow:"hidden" }}>
        <div style={{ padding:"50px 18px 0",display:"flex",alignItems:"flex-start",justifyContent:"space-between" }}>
          <button onClick={onBack} style={{ width:38,height:38,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888888" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:"#fff" }}>{workoutName}</div>
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{workoutDate}</div>
          </div>
          <div style={{ background:`${PRIMARY}22`,border:`1.5px solid ${PRIMARY}66`,borderRadius:20,padding:"6px 14px" }}>
            <span style={{ fontFamily:FONT,fontWeight:800,fontSize:10,color:PRIMARY,letterSpacing:1 }}>{workoutType}</span>
          </div>
        </div>

        {/* Collapsible stat tiles */}
        <div style={{ maxHeight:headerCollapsed?"0px":"120px",opacity:headerCollapsed?0:1,transition:"max-height 0.35s ease, opacity 0.25s ease",overflow:"hidden",padding:headerCollapsed?"0 16px":"12px 16px 0" }}>
          <div style={{ display:"flex",gap:10 }}>
            {[
              { ico:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.8"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>, val:workoutCalories, lbl:"Calories", c:"#EF4444" },
              { ico:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, val:workoutDuration, lbl:"Minutes", c:PRIMARY },
              { ico:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>, val:workoutMood, lbl:"Mood", c:"#8B5CF6" },
            ].map((s,i)=>(
              <div key={i} style={{ flex:1,background:CARD,borderRadius:16,border:`1px solid ${BORDER}`,padding:"12px 8px",textAlign:"center" }}>
                <div style={{ display:"flex",justifyContent:"center",marginBottom:5,color:s.c }}>{s.ico}</div>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#ffffff",lineHeight:1 }}>{s.val}</div>
                <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",marginTop:3 }}>{s.lbl}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ padding:"12px 16px 0" }}>
          <div style={{ display:"flex",gap:0,background:CARD,borderRadius:12,padding:4,border:`1px solid ${BORDER}` }}>
            {[["recap","AI Recap"],["breakdown","Breakdown"],["exercises","Exercises"]].map(([k,lbl])=>(
              <button key={k} onClick={()=>setTab(k)} style={{ flex:1,padding:"8px 0",borderRadius:10,border:"none",background:tab===k?PRIMARY:"transparent",fontFamily:FONT,fontWeight:700,fontSize:12,color:tab===k?"#fff":"#888",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:4,transition:"all 0.2s" }}>
                {lbl}
                {!isPremium&&(k==="breakdown"||k==="exercises")&&(
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── SCROLL CONTENT ── */}
      <div ref={(el)=>{scrollRef.current=el;if(aiScrollRef)aiScrollRef.current=el;}} onScroll={onScroll} style={{ flex:1,overflowY:"auto",padding:"12px 16px 40px" }}>

        {/* ════ TAB: AI RECAP ════ */}
        {tab==="recap" && (
          <div style={{ animation:"fadeUp 0.35s ease both" }}>
            {/* Glowing AI card */}
            <div style={{ background:cardBg,borderRadius:22,border:cardBorder,padding:"22px 20px",marginBottom:14,boxShadow:"0 0 40px rgba(109,40,217,0.15)" }}>
              <div style={{ display:"flex",gap:14,alignItems:"center",marginBottom:16 }}>
                <div style={{ width:52,height:52,borderRadius:"50%",background:"linear-gradient(135deg,#7C3AED,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 0 24px rgba(124,58,237,0.6)",animation:"glow 3s ease infinite" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </div>
                <div>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#8B5CF6",letterSpacing:2,marginBottom:4 }}>AI POWERED RECAP</div>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff" }}>VTRX Coach Analysis</div>
                </div>
              </div>
              <div style={{ height:1,background:"rgba(255,255,255,0.06)",marginBottom:16 }}/>
              {isPremium ? (
                <>
                  <div style={{ fontFamily:FONT,fontSize:14,color:"rgba(255,255,255,0.88)",lineHeight:1.78,marginBottom:aiCoachText?14:0,whiteSpace:"pre-line" }}>
                    {twText}
                    {!twDone&&<span style={{ display:"inline-block",width:2,height:16,background:PRIMARY,marginLeft:2,animation:"blink 0.9s infinite",verticalAlign:"text-bottom",borderRadius:1 }}/>}
                  </div>
                  {twDone && aiCoachText ? (
                    <div style={{ fontFamily:FONT,fontSize:13,color:"rgba(255,255,255,0.65)",lineHeight:1.7,borderTop:"1px solid rgba(255,255,255,0.06)",paddingTop:14,marginTop:4 }}>{aiCoachText}</div>
                  ) : null}
                </>
              ) : (
                <div style={{ position:"relative" }}>
                  <div style={{ maxHeight:72,overflow:"hidden",fontFamily:FONT,fontSize:14,color:"rgba(255,255,255,0.88)",lineHeight:1.78,whiteSpace:"pre-line" }}>
                    {twText}
                    {!twDone&&<span style={{ display:"inline-block",width:2,height:16,background:PRIMARY,marginLeft:2,animation:"blink 0.9s infinite",verticalAlign:"text-bottom",borderRadius:1 }}/>}
                  </div>
                  <div style={{ position:"absolute",bottom:0,left:0,right:0,height:52,background:"linear-gradient(transparent,#0a0f1e)" }}/>
                </div>
              )}
            </div>

            {/* Free-user upgrade gate */}
            {!isPremium && (
              <div style={{ background:"linear-gradient(145deg,#1a0533,#0d0d1a)",borderRadius:22,border:"1.5px solid #7C3AED55",padding:"28px 22px",marginBottom:14,textAlign:"center" }}>
                <div style={{ width:56,height:56,borderRadius:"50%",background:"rgba(124,58,237,0.18)",border:"1.5px solid rgba(124,58,237,0.4)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px" }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                </div>
                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff",marginBottom:8 }}>Unlock Full Analysis</div>
                <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.65,marginBottom:6 }}>You're on the <span style={{ color:"#8B5CF6",fontWeight:700 }}>Free Plan</span> — 1 AI summary per week.</div>
                <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.65,marginBottom:22 }}>Upgrade to <span style={{ color:"#F59E0B",fontWeight:700 }}>Premium</span> for a full AI breakdown after every single workout.</div>
                <button onClick={()=>openPaymentSheet("monthly")} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:"linear-gradient(135deg,#7C3AED,#4C1D95)",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",letterSpacing:1,boxShadow:"0 4px 24px rgba(124,58,237,0.45)" }}>
                  UPGRADE TO PREMIUM
                </button>
              </div>
            )}

            {/* Achievements — premium only */}
            {isPremium && achievements.length > 0 && (
              <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14,animation:"fadeUp 0.35s ease both" }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>ACHIEVEMENTS</div>
                <div style={{ display:"flex",flexWrap:"wrap",gap:8 }}>
                  {achievements.map((a,i)=>(
                    <div key={i} style={{ background:"#EAB30818",border:"1px solid #EAB30844",borderRadius:20,padding:"6px 14px",display:"flex",alignItems:"center",gap:6 }}>
                      <span style={{ fontSize:14 }}>{a.icon||"🏅"}</span>
                      <span style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#EAB308" }}>{a.label||a}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Key Insights — premium only */}
            {isPremium && keyInsights.length > 0 && (
              <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14,animation:"fadeUp 0.35s ease both" }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>KEY INSIGHTS</div>
                {keyInsights.map((ins,i)=>(
                  <div key={i} style={{ display:"flex",gap:10,alignItems:"flex-start",marginBottom:i<keyInsights.length-1?12:0 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5" style={{flexShrink:0,marginTop:2}}><polyline points="20 6 9 17 4 12"/></svg>
                    <span style={{ fontFamily:FONT,fontSize:13,color:"rgba(255,255,255,0.8)",lineHeight:1.6 }}>{ins}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Mood Analysis — premium only */}
            {isPremium && moodAnalysis && (
              <div style={{ background:cardBg,borderRadius:18,border:cardBorder,padding:"18px",marginBottom:14,animation:"fadeUp 0.35s ease both" }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1 }}>MOOD ANALYSIS</div>
                  {moodAnalysis.moodImpact && (
                    <div style={{ background:moodAnalysis.moodImpact==="positive"?"#22C55E22":moodAnalysis.moodImpact==="negative"?"#EF444422":"#EAB30822",border:`1px solid ${moodAnalysis.moodImpact==="positive"?"#22C55E44":moodAnalysis.moodImpact==="negative"?"#EF444444":"#EAB30844"}`,borderRadius:20,padding:"4px 12px" }}>
                      <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:moodAnalysis.moodImpact==="positive"?"#22C55E":moodAnalysis.moodImpact==="negative"?"#EF4444":"#EAB308",textTransform:"capitalize" }}>{moodAnalysis.moodImpact}</span>
                    </div>
                  )}
                </div>
                <p style={{ fontFamily:FONT,fontSize:13,color:"rgba(255,255,255,0.75)",lineHeight:1.65,margin:0 }}>{moodAnalysis.description||moodAnalysis}</p>
              </div>
            )}

            {/* Recommendations — premium only */}
            {isPremium && recommendations.length > 0 && (
              <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:14,animation:"fadeUp 0.35s ease both" }}>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>RECOMMENDATIONS</div>
                {recommendations.map((rec,i)=>(
                  <div key={i} style={{ display:"flex",gap:12,alignItems:"flex-start",marginBottom:i<recommendations.length-1?14:0 }}>
                    <div style={{ width:22,height:22,borderRadius:"50%",background:`${PRIMARY}22`,border:`1px solid ${PRIMARY}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1 }}>
                      <span style={{ fontFamily:FONT,fontWeight:800,fontSize:10,color:PRIMARY }}>{i+1}</span>
                    </div>
                    <span style={{ fontFamily:FONT,fontSize:13,color:"rgba(255,255,255,0.8)",lineHeight:1.65 }}>{rec}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Post-workout mood */}
            <div style={{ background:cardBg,borderRadius:20,border:cardBorder,padding:"20px 18px",animation:"fadeUp 0.35s ease both" }}>
              <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:6 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff" }}>How are you feeling now?</div>
              </div>
              <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",marginBottom:20 }}>Your feedback helps me tailor your next session.</div>
              <div style={{ display:"flex",justifyContent:"space-around" }}>
                {postMoods.map(m=>(
                  <button key={m.key} onClick={()=>{
                    setPostMood(m.key);
                    const moodMap = { drained: 'low', okay: 'okay', good: 'good', pumped: 'peak' };
                    apiCall('/users/mood', {
                      method: 'POST',
                      body: JSON.stringify({ mood: moodMap[m.key] || 'okay', notes: 'Post-workout mood check-in' }),
                    }).catch(() => {});
                  }} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:8,background:"none",border:"none",cursor:"pointer" }}>
                    <div style={{ width:56,height:56,borderRadius:"50%",border:`2px solid ${postMood===m.key?m.color:BORDER}`,background:postMood===m.key?`${m.color}22`:"transparent",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s",boxShadow:postMood===m.key?`0 0 16px ${m.color}55`:"none",transform:postMood===m.key?"scale(1.1)":"scale(1)" }}><PostMoodIcon type={m.key} color={m.color}/></div>
                    <span style={{ fontFamily:FONT,fontSize:11,color:postMood===m.key?m.color:"#888888",fontWeight:postMood===m.key?700:500,transition:"all 0.2s" }}>{m.label}</span>
                  </button>
                ))}
              </div>
              {postMood && <div style={{ marginTop:18,textAlign:"center",animation:"fadeUp 0.3s ease both" }}><div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#22C55E" }}>Thanks! We'll adjust tomorrow's plan.</div></div>}
            </div>
          </div>
        )}

        {/* ════ TAB: BREAKDOWN ════ */}
        {tab==="breakdown" && (
          <div style={{ animation:"fadeUp 0.35s ease both" }}>
            {!isPremium ? (
              <PaywallCard title="Performance Breakdown" description="Unlock your full performance score, muscle group breakdown, intensity metrics and more with VTRX Pro."/>
            ) : (
              <div>
                {/* Overall score circle */}
                <div style={{ background:cardBg,borderRadius:20,border:cardBorder,padding:"22px 18px",marginBottom:14,textAlign:"center" }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:2,marginBottom:10 }}>OVERALL SESSION SCORE</div>
                  <div style={{ position:"relative",width:110,height:110,margin:"0 auto 14px" }}>
                    <svg width="110" height="110" style={{ transform:"rotate(-90deg)" }}>
                      <circle cx="55" cy="55" r="46" fill="none" stroke="#1a1a2e" strokeWidth="10"/>
                      <circle cx="55" cy="55" r="46" fill="none" stroke={PRIMARY} strokeWidth="10"
                        strokeDasharray={`${2*Math.PI*46}`}
                        strokeDashoffset={`${2*Math.PI*46*(1-overallScore/100)}`}
                        strokeLinecap="round" style={{ transition:"stroke-dashoffset 1.4s ease" }}/>
                    </svg>
                    <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
                      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:28,color:PRIMARY,lineHeight:1 }}>{overallScore}</div>
                      <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",letterSpacing:1,marginTop:2 }}>/ 100</div>
                    </div>
                  </div>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:overallScore>=80?"#22C55E":overallScore>=60?"#F97316":"#EF4444",marginBottom:4 }}>{overallScore>=80?"Excellent":overallScore>=60?"Good":"Needs Work"}</div>
                </div>

                {/* Metrics grid */}
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14 }}>
                  {metricCards.map((mc,i)=>(
                    <div key={i} style={{ background:CARD,borderRadius:16,border:`1px solid ${BORDER}`,padding:"16px 14px",textAlign:"center" }}>
                      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:24,color:mc.color,lineHeight:1,marginBottom:6 }}>{mc.val}</div>
                      <div style={{ fontFamily:FONT,fontSize:11,color:"#888888" }}>{mc.label}</div>
                    </div>
                  ))}
                </div>

                {/* Muscle Group Analysis */}
                {muscleGroups.length > 0 && (
                  <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px" }}>
                    <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:16 }}>MUSCLE GROUP ANALYSIS</div>
                    {muscleGroups.map((mg,i)=>{
                      const name = mg.name||mg.muscle||mg;
                      const pct = mg.percentage||mg.pct||50;
                      const c = getMuscleColor(name);
                      return (
                        <div key={i} style={{ marginBottom:i<muscleGroups.length-1?14:0 }}>
                          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:6 }}>
                            <span style={{ fontFamily:FONT,fontSize:14,color:"#888888" }}>{name}</span>
                            <span style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:c }}>{pct}%</span>
                          </div>
                          <div style={{ height:8,background:"#1a1a1a",borderRadius:8,overflow:"hidden" }}>
                            <div style={{ height:"100%",width:barReady?`${pct}%`:"0%",background:c,borderRadius:8,transition:`width ${1+i*0.1}s ease` }}/>
                          </div>
                        </div>
                      );
                    })}
                    {muscleGroups.length===0&&(
                      <div style={{ fontFamily:FONT,fontSize:13,color:"#888",textAlign:"center",padding:"12px 0" }}>No muscle data available.</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ════ TAB: EXERCISES ════ */}
        {tab==="exercises" && (
          <div style={{ animation:"fadeUp 0.35s ease both" }}>
            {!isPremium ? (
              <PaywallCard title="Exercise Breakdown" description="See every exercise, set, rep count and personal records from this session with VTRX Pro."/>
            ) : exerciseBreakdown.length===0 ? (
              <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"40px 20px",textAlign:"center" }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#444" strokeWidth="1.5" style={{marginBottom:14}}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
                <div style={{ fontFamily:FONT,fontSize:14,color:"#888" }}>No exercise breakdown available for this session.</div>
              </div>
            ) : (
              <div>
                {exerciseBreakdown.map((ex,i)=>{
                  const isExpanded = expandedEx===i;
                  const trend = ex.trend||ex.performance||"maintained";
                  const trendIcon = trend==="improved"?"↑":trend==="declined"?"↓":"→";
                  const trendColor = trend==="improved"?"#22C55E":trend==="declined"?"#EF4444":"#888888";
                  const reps = ex.repsPerSet||[];
                  return (
                    <div key={i} style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:10,animation:`fadeUp 0.3s ease ${i*0.06}s both`,cursor:"pointer" }} onClick={()=>setExpandedEx(isExpanded?null:i)}>
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                        <div style={{ flex:1 }}>
                          <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}>
                            <span style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff" }}>{ex.name||ex.exerciseName}</span>
                            {ex.isPR&&<div style={{ background:"#EAB30822",border:"1px solid #EAB30844",borderRadius:8,padding:"2px 8px" }}><span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#EAB308",letterSpacing:1 }}>🏆 NEW PR</span></div>}
                          </div>
                          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                            <span style={{ fontFamily:FONT,fontSize:12,color:"#888" }}>{ex.sets||reps.length||0} sets</span>
                            <span style={{ fontFamily:FONT,fontSize:13,fontWeight:700,color:trendColor }}>{trendIcon}</span>
                          </div>
                        </div>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" style={{ transform:isExpanded?"rotate(180deg)":"none",transition:"transform 0.2s" }}><polyline points="6 9 12 15 18 9"/></svg>
                      </div>
                      {isExpanded && (
                        <div style={{ marginTop:14,borderTop:`1px solid ${BORDER}`,paddingTop:14,animation:"fadeUp 0.2s ease both" }}>
                          {reps.length>0&&(
                            <div style={{ marginBottom:12 }}>
                              <div style={{ fontFamily:FONT,fontSize:11,color:"#888",letterSpacing:1,marginBottom:8 }}>REPS PER SET</div>
                              <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                                {reps.map((r,ri)=>(
                                  <div key={ri} style={{ background:`${PRIMARY}18`,border:`1px solid ${PRIMARY}44`,borderRadius:10,padding:"4px 12px" }}>
                                    <span style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:PRIMARY }}>Set {ri+1}: {r}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <div style={{ display:"flex",gap:16 }}>
                            {ex.maxWeight!=null&&<div><div style={{ fontFamily:FONT,fontSize:11,color:"#888",marginBottom:2 }}>Max Weight</div><div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff" }}>{ex.maxWeight}kg</div></div>}
                            {ex.totalVolume!=null&&<div><div style={{ fontFamily:FONT,fontSize:11,color:"#888",marginBottom:2 }}>Total Volume</div><div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff" }}>{ex.totalVolume}kg</div></div>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

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
  const bottomPad = slide.cta ? 240 : 70;
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
          <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14,animation:rdy?"fadeUp 0.5s ease 0.15s both":"none" }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:11,color:PRIMARY,letterSpacing:3 }}>{slide.tag}</div>
            {slide.comingSoon&&<div style={{ background:"rgba(255,165,0,0.2)",border:"1px solid rgba(255,165,0,0.6)",borderRadius:20,padding:"2px 10px" }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:9,color:"#FFA500",letterSpacing:1.5 }}>COMING SOON</span>
            </div>}
          </div>
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
  if (type==="muscle") return <svg {...s}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
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
  const [step, setStep]           = useState("email"); // email → code → done
  const [email, setEmail]         = useState("");
  const [code,  setCode]          = useState("");
  const [newPass, setNewPass]     = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [err, setErr]             = useState("");
  const [loading, setLoading]     = useState(false);
  const { signIn, setActive } = useClerkSignIn();

  const sendCode = async () => {
    if (!email.trim()) { setErr("Please enter your email."); return; }
    setErr(""); setLoading(true);
    try {
      await signIn.create({
        strategy: 'reset_password_email_code',
        identifier: email.trim().toLowerCase(),
      });
      setStep("code");
    } catch (e) {
      const clerkErr = e?.errors?.[0];
      // Treat "user not found" as success to avoid email enumeration
      if (clerkErr?.code === 'form_identifier_not_found') { setStep("code"); }
      else { setErr(clerkErr?.longMessage || clerkErr?.message || e?.message || "Failed to send code."); }
    }
    finally { setLoading(false); }
  };

  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

  const resetPass = async () => {
    if (!code.trim() || code.trim().length !== 6) { setErr("Please enter the complete 6-digit code."); return; }
    if (!passwordRegex.test(newPass)) {
      setErr("Password must be at least 8 characters and include uppercase, lowercase, and a number.");
      return;
    }
    if (newPass !== confirmPass) { setErr("Passwords do not match."); return; }
    setErr(""); setLoading(true);
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code: code.trim(),
        password: newPass,
      });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
      }
      setStep("done");
    } catch (e) {
      const clerkErr = e?.errors?.[0];
      if (clerkErr?.code === 'form_code_incorrect') { setErr("Incorrect code. Please try again."); }
      else if (clerkErr?.code === 'form_code_expired') { setErr("Code expired. Please request a new one."); }
      else if (clerkErr?.code?.includes('password')) { setErr(clerkErr?.longMessage || clerkErr?.message || "Password does not meet requirements."); }
      else { setErr(clerkErr?.longMessage || clerkErr?.message || e?.message || "Failed to reset password."); }
    }
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
            <input value={newPass} onChange={e=>setNewPass(e.target.value)} placeholder="Min 8 chars, uppercase & number" type="password"
              style={{ width:"100%",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:14,padding:"15px 18px",fontFamily:FONT,fontSize:16,color:"#fff",outline:"none",boxSizing:"border-box",marginBottom:16 }}/>
            <div style={{ fontFamily:FONT,fontSize:11,fontWeight:700,color:"#888",letterSpacing:1,marginBottom:6 }}>CONFIRM NEW PASSWORD</div>
            <input value={confirmPass} onChange={e=>setConfirmPass(e.target.value)} placeholder="Re-enter new password" type="password"
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

function LoginScreen({ onLogin, onSignUp, onForgot, onEmailVerify }) {
  const { setUser } = useUser();   // ← This was missing
  const { signIn, setActive } = useClerkSignIn();
  const { isLoaded: clerkLoaded, isSignedIn } = useClerkAuth();

  React.useEffect(() => {
    if (!clerkLoaded || !isSignedIn) return;
    // Already signed in (e.g., after password reset) — fetch profile and route.
    // skipAuthRedirect: a 401 here (fresh session, first authenticated call) should
    // route to onboarding via the catch below, not force a full Clerk sign-out.
    apiCall("/users/profile", { skipAuthRedirect: true })
      .then(res => onLogin(res?.data?.user || {}))
      .catch(() => onLogin({}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clerkLoaded, isSignedIn]);

  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const validateField = (field, value) => {
    if (!submitted) return;
    if (field === "email") {
      if (!value.trim()) setErrors(p => ({...p, email: "Email is required."}));
      else if (!emailRegex.test(value.trim())) setErrors(p => ({...p, email: "Please enter a valid email address."}));
      else setErrors(p => ({...p, email: undefined}));
    }
    if (field === "pass") {
      if (!value.trim()) setErrors(p => ({...p, pass: "Password is required."}));
      else setErrors(p => ({...p, pass: undefined}));
    }
  };

  const handle = async () => {
    setSubmitted(true);
    const errs = {};
    if (!email.trim()) errs.email = "Email is required.";
    else if (!emailRegex.test(email.trim())) errs.email = "Please enter a valid email address.";
    if (!pass.trim()) errs.pass = "Password is required.";

    if (Object.keys(errs).length) { 
      setErrors(errs); 
      return; 
    }

    setErrors({}); 
    setLoading(true);

    try {
      const result = await signIn.create({
        identifier: email.trim().toLowerCase(),
        password: pass,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        // Fetch Prisma user profile now that Clerk session is active.
        // skipAuthRedirect: this is the first authenticated call of a fresh session —
        // a 401 here must not trigger a full Clerk sign-out (that's what was bouncing
        // users straight back to the login screen after a successful login).
        try {
          const profileRes = await apiCall("/users/profile", { skipAuthRedirect: true });
          const u = profileRes?.data?.user || {};
          if (u.id) setUser(prev => ({...prev, ...u}));
          onLogin(u);
        } catch(_) {
          onLogin({});
        }
      } else {
        setErrors({ general: "Login incomplete — please try again." });
      }
    } catch (e) {
      console.error(e);
      const clerkErr = e?.errors?.[0];
      if (clerkErr?.code === 'session_exists' || e?.status === 422) {
        // Already signed in
        onLogin({});
      } else if (clerkErr?.code === 'form_identifier_not_found' || clerkErr?.code === 'form_password_incorrect' || clerkErr?.code === 'not_found') {
        setErrors({ general: "Incorrect email or password." });
      } else if (clerkErr?.code === 'strategy_for_user_invalid' || clerkErr?.code === 'verification_failed') {
        setErrors({ general: "Please verify your email before logging in." });
        if (onEmailVerify) onEmailVerify(email.trim().toLowerCase());
      } else {
        setErrors({ general: clerkErr?.longMessage || clerkErr?.message || e?.message || "Incorrect email or password." });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Shell
      bg="https://images.unsplash.com/photo-1517963879433-6ad2b056d712?w=800&q=80"
      overlay="linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.6) 40%,rgba(0,0,0,0.95) 100%)"
    >
      {/* Logo header */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", paddingTop:50 }}>
        <VTRXLogo size={50}/>
        <div style={{ fontFamily:FONT, fontWeight:900, fontSize:28, color:PRIMARY, letterSpacing:5, marginTop:10, marginBottom:4 }}>VTRX</div>
        <div style={{ fontFamily:FONT, fontWeight:600, fontSize:10, color:"rgba(255,255,255,0.8)", letterSpacing:3 }}>WELCOME BACK</div>
      </div>

      {/* Form */}
      <div style={{ padding:"0 26px 48px", display:"flex", flexDirection:"column", gap:14 }}>
        {/* Email field */}
        <div style={{ position:"relative" }}>
          <div style={{ position:"absolute", left:18, top:"50%", transform:"translateY(-50%)", zIndex:1, display:"flex", alignItems:"center" }}>
            <BodyFieldIcon type="email"/>
          </div>
          <input
            value={email} 
            onChange={e=>{ setEmail(e.target.value); setErrors(p=>({...p,email:undefined})); }} 
            onBlur={e=>validateField("email", e.target.value)}
            placeholder="Email address" 
            type="email"
            autoCapitalize="none" 
            autoCorrect="off"
            style={{ width:"100%", background:"rgba(255,255,255,0.92)", borderRadius:50, border:`2px solid ${submitted&&errors.email?"#EF4444":"transparent"}`, padding:"16px 18px 16px 44px", fontFamily:FONT, fontSize:14, fontWeight:500, color:"#111", outline:"none", boxSizing:"border-box" }}
          />
        </div>

        {/* Password field */}
        <div style={{ position:"relative" }}>
          <div style={{ position:"absolute", left:18, top:"50%", transform:"translateY(-50%)", zIndex:1, display:"flex", alignItems:"center" }}>
            <BodyFieldIcon type="lock"/>
          </div>
          <input
            value={pass} 
            onChange={e=>{ setPass(e.target.value); setErrors(p=>({...p,pass:undefined})); }} 
            onBlur={e=>validateField("pass", e.target.value)}
            placeholder="Password" 
            type={showPass?"text":"password"}
            onKeyDown={e=>e.key==="Enter"&&handle()}
            style={{ width:"100%", background:"rgba(255,255,255,0.92)", borderRadius:50, border:`2px solid ${submitted&&errors.pass?"#EF4444":"transparent"}`, padding:"16px 46px 16px 44px", fontFamily:FONT, fontSize:14, fontWeight:500, color:"#111", outline:"none", boxSizing:"border-box" }}
          />
          <button onClick={()=>setShowPass(p=>!p)}
            style={{ position:"absolute", right:18, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", padding:0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2">
              {showPass
                ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
              }
            </svg>
          </button>
        </div>

        {/* Errors */}
        {submitted && errors.email && <div style={{ fontFamily:FONT, fontSize:12, color:"#EF4444", marginTop:6, marginBottom:4, paddingLeft:20 }}>⚠ {errors.email}</div>}
        {submitted && errors.pass && <div style={{ fontFamily:FONT, fontSize:12, color:"#EF4444", marginTop:6, marginBottom:4, paddingLeft:20 }}>⚠ {errors.pass}</div>}
        {errors.general && <div style={{ fontFamily:FONT, fontSize:13, color:"#EF4444", textAlign:"center", marginTop:8, padding:"10px 16px", background:"rgba(239,68,68,0.1)", borderRadius:12, border:"1px solid rgba(239,68,68,0.3)" }}>{errors.general}</div>}

        {/* Forgot password */}
        <div style={{ textAlign:"right", marginTop:-6 }}>
          <button onClick={onForgot} style={{ background:"none", border:"none", fontFamily:FONT, fontSize:13, color:"rgba(255,255,255,0.6)", cursor:"pointer", padding:0 }}>
            Forgot password?
          </button>
        </div>

        {/* Sign in button */}
        <div style={{ marginTop:4 }}>
          <CTA label={loading ? "SIGNING IN..." : "SIGN IN"} onClick={handle}/>
        </div>

        {/* Sign up link */}
        <div style={{ textAlign:"center" }}>
          <span style={{ fontFamily:FONT, fontSize:13, color:"rgba(255,255,255,0.6)" }}>Don't have an account? </span>
          <button onClick={onSignUp} style={{ background:"none", border:"none", fontFamily:FONT, fontSize:13, color:"#fff", fontWeight:800, cursor:"pointer", padding:0 }}>
            Sign up
          </button>
        </div>
      </div>
    </Shell>
  );
}

function SignUpScreen({ onContinue, onBack, onLogin }) {
  const [f, setF]         = useState({ name:"", username:"", email:"", password:"", confirm:"" });
  const [errors,    setErrors]    = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const { signUp } = useClerkSignUp();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const validateField = (key, value) => {
    if (!submitted) return;
    const e = {};
    if (key==="name"     && !value.trim())             e.name     = "Full name is required.";
    if (key==="username" && !value.trim())             e.username = "Username is required.";
    if (key==="email"    && !value.trim())             e.email    = "Email is required.";
    if (key==="email"    && value.trim() && !emailRegex.test(value.trim())) e.email = "Please enter a valid email (e.g. you@example.com).";
    if (key==="password" && value.length < 8)          e.password = "Password must be at least 8 characters.";
    if (key==="confirm"  && value !== f.password)      e.confirm  = "Passwords do not match.";
    // Clear error if field is now valid, keep it if still invalid
    setErrors(p => ({ ...p, [key]: e[key] }));
  };

   const handle = async () => {
    setSubmitted(true);
    const errs = {};
    if (!f.name.trim())                       errs.name     = "Full name is required.";
    if (!f.username.trim())                   errs.username = "Username is required.";
    if (!f.email.trim())                      errs.email    = "Email is required.";
    else if (!emailRegex.test(f.email.trim())) errs.email   = "Please enter a valid email.";
    if (f.password.length < 8)                errs.password = "Password must be at least 8 characters.";
    if (f.password !== f.confirm)             errs.confirm  = "Passwords do not match.";
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({}); setLoading(true);

    try {
      await signUp.create({
        emailAddress: f.email.trim().toLowerCase(),
        password:     f.password,
        username:     f.username.trim().toLowerCase(),
        firstName:    f.name.split(' ')[0],
        lastName:     f.name.split(' ').slice(1).join(' ') || undefined,
      });
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      onContinue(f.email.trim().toLowerCase(), f.password);
    } catch (e) {
      const clerkErr = e?.errors?.[0];
      if (clerkErr?.code === 'form_identifier_exists') {
        setErrors({ general: "An account with this email already exists." });
      } else if (clerkErr?.code === 'form_password_pwned' || clerkErr?.code?.includes('password')) {
        setErrors({ general: clerkErr?.longMessage || clerkErr?.message || "Password does not meet requirements." });
      } else {
        setErrors({ general: clerkErr?.longMessage || clerkErr?.message || e?.message || "Signup failed. Please try again." });
      }
    } finally {
      setLoading(false);
    }
  };

  const fields = [
    { key:"name",     icon:"user",  placeholder:"Full name",        type:"text"     },
    { key:"username", icon:"user",  placeholder:"Username",         type:"text"     },
    { key:"email",    icon:"email", placeholder:"Email address",    type:"email"    },
    { key:"password", icon:"lock",  placeholder:"Password (min 8)", type:"password", toggle: true, show: showPass, setShow: setShowPass },
    { key:"confirm",  icon:"lock",  placeholder:"Confirm password", type:"password", toggle: true, show: showConfirm, setShow: setShowConfirm },
  ];

  return (
    <Shell
      bg="https://images.unsplash.com/photo-1571902943202-507ec2618e8f?w=800&q=80"
      overlay="linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.58) 45%,rgba(0,0,0,0.92) 100%)"
    >
      {/* Logo header */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", paddingTop:50 }}>
        <VTRXLogo size={50}/>
        <div style={{ fontFamily:FONT, fontWeight:900, fontSize:28, color:PRIMARY, letterSpacing:5, marginTop:10, marginBottom:4 }}>VTRX</div>
        <div style={{ fontFamily:FONT, fontWeight:600, fontSize:10, color:"rgba(255,255,255,0.8)", letterSpacing:3 }}>UNLEASH YOUR FULL POTENTIAL</div>
      </div>

      {/* Form */}
      <div style={{ padding:"0 26px 40px", display:"flex", flexDirection:"column", gap:12 }}>

        {fields.map(({ key, icon, placeholder, type, toggle, show, setShow }) => (
          <div key={key} style={{ position:"relative" }}>
            <div style={{ position:"absolute", left:18, top:"50%", transform:"translateY(-50%)", zIndex:1, display:"flex", alignItems:"center" }}>
              <BodyFieldIcon type={icon}/>
            </div>
            <input
              value={f[key]}
              onChange={e=>{ const v=e.target.value; setF(p=>({...p,[key]:v})); setErrors(p=>({...p,[key]:undefined})); }}
              onBlur={e=>validateField(key, e.target.value)}
              placeholder={placeholder}
              type={toggle ? (show ? "text" : "password") : type}
              autoCapitalize="none" autoCorrect="off"
              style={{ width:"100%", background:"rgba(255,255,255,0.92)", borderRadius:50, border:`2px solid ${submitted&&errors[key]?"#EF4444":"transparent"}`, padding:`16px ${toggle ? 46 : 18}px 16px 44px`, fontFamily:FONT, fontSize:14, fontWeight:500, color:"#111", outline:"none", boxSizing:"border-box" }}
            />
            {toggle && (
              <button onClick={()=>setShow(p=>!p)}
                style={{ position:"absolute", right:18, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", padding:0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2">
                  {show
                    ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                    : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
                  }
                </svg>
              </button>
            )}
          </div>
        ))}

        {/* Per-field errors — only shown after first submit attempt */}
        {submitted && Object.entries(errors).filter(([k])=>k!=="general").map(([k,v])=>(
          <div key={k} style={{ fontFamily:FONT, fontSize:12, color:"#EF4444", marginBottom:4, paddingLeft:8 }}>⚠ {v}</div>
        ))}
        {errors.general && <div style={{ fontFamily:FONT, fontSize:13, color:"#EF4444", textAlign:"center", padding:"10px 16px", background:"rgba(239,68,68,0.1)", borderRadius:12, border:"1px solid rgba(239,68,68,0.3)", marginBottom:8 }}>{errors.general}</div>}

        {/* Sign up button */}
        <div style={{ marginTop:4 }}>
          <CTA label={loading ? "CREATING ACCOUNT..." : "SIGN UP"} onClick={handle}/>
        </div>

        {/* Log in link */}
        <div style={{ textAlign:"center" }}>
          <span style={{ fontFamily:FONT, fontSize:13, color:"rgba(255,255,255,0.6)" }}>Already have an account? </span>
          <button onClick={onLogin} style={{ background:"none", border:"none", fontFamily:FONT, fontSize:13, color:"#fff", fontWeight:800, cursor:"pointer", padding:0 }}>
            Log In
          </button>
        </div>

        <div style={{ fontFamily:FONT, fontSize:11, color:"rgba(255,255,255,0.35)", textAlign:"center", lineHeight:1.5 }}>
          By signing up you agree to our Terms of Service and Privacy Policy.
        </div>
      </div>
    </Shell>
  );
}

function EmailVerifyScreen({ email: emailProp, onVerified, onBack }) {
  const email = emailProp || "";
  const { signUp, setActive } = useClerkSignUp();
  const [code,      setCode]      = React.useState("");
  const [loading,   setLoading]   = React.useState(false);
  const [error,     setError]     = React.useState("");
  const [resending, setResending] = React.useState(false);
  const [cooldown,  setCooldown]  = React.useState(0);

  const verify = async () => {
    if (code.length !== 6) { setError("Please enter the full 6-digit code"); return; }
    setLoading(true); setError("");
    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
        onVerified();
      } else {
        throw new Error("Verification incomplete — please try again");
      }
    } catch (e) {
      const clerkErr = e?.errors?.[0];
      setError(clerkErr?.longMessage || clerkErr?.message || e?.message || "Invalid or expired code. Please try again.");
    } finally { setLoading(false); }
  };

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const resend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true); setError("");
    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setError("New code sent — check your inbox (and spam folder).");
      setCooldown(60);
      setTimeout(() => setError(""), 5000);
    } catch (e) {
      const clerkErr = e?.errors?.[0];
      setError(clerkErr?.message || e?.message || "Failed to resend code. Please try again.");
    } finally { setResending(false); }
  };

  return (
    <div style={{ position:"absolute",inset:0,background:"#0a0a0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px" }}>
      <VTRXLogo size={28}/>
      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#fff",marginTop:20,marginBottom:8,textAlign:"center" }}>Check your email</div>
      <div style={{ fontFamily:FONT,fontSize:14,color:"#666",textAlign:"center",lineHeight:1.6,marginBottom:32 }}>
        We sent a 6-digit code to<br/>
        <span style={{ color:PRIMARY,fontWeight:700 }}>{email}</span>
      </div>

      <input
        value={code}
        onChange={e=>setCode(e.target.value.replace(/[^0-9]/g,"").slice(0,6))}
        placeholder="000000"
        inputMode="numeric"
        maxLength={6}
        style={{ width:"100%",background:"rgba(255,255,255,0.06)",border:`2px solid ${code.length===6?PRIMARY:BORDER}`,borderRadius:16,padding:"18px 0",fontFamily:FONT,fontWeight:800,fontSize:28,color:"#fff",outline:"none",textAlign:"center",letterSpacing:12,marginBottom:8,boxSizing:"border-box",transition:"border-color 0.2s" }}
      />

      {error && <div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:16,textAlign:"center",fontWeight:600 }}>{error}</div>}

      <button
        onClick={verify}
        disabled={loading || code.length !== 6}
        style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1.5,cursor:loading?"not-allowed":"pointer",opacity:loading||code.length!==6?0.7:1,marginBottom:16,boxShadow:`0 4px 24px ${PRIMARY}44` }}
      >
        {loading ? "VERIFYING..." : "VERIFY EMAIL"}
      </button>

      <button onClick={resend} disabled={cooldown > 0 || resending}
        style={{ background:"none",border:"none",fontFamily:FONT,fontSize:13,color:cooldown>0?"#555":PRIMARY,cursor:cooldown>0||resending?"default":"pointer",marginBottom:12,opacity:cooldown>0?0.6:1 }}>
        {resending ? "Sending..." : cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
      </button>
      <button onClick={onBack} style={{ background:"none",border:"none",fontFamily:FONT,fontSize:13,color:"#555",cursor:"pointer" }}>
        Back to Sign Up
      </button>
    </div>
  );
}

function BodyScreen({ onContinue, onBack }) {
  const { user, setUser } = useUser();
  const [weightUnit, setWeightUnit] = useState("lbs");
  const [heightUnit, setHeightUnit] = useState("ft");
  const [weight,  setWeight]  = useState(user.weight || "");
  const [height,  setHeight]  = useState("");  // always stored as display string
  const [dob,     setDob]     = useState("");
  const [gender,  setGender]  = useState(user.gender || "");
  const [goalW,   setGoalW]   = useState("");
  const [bf,      setBf]      = useState("");

  // When switching weight unit, convert value
  const switchWeightUnit = (u) => {
    if (weight && !isNaN(parseFloat(weight))) {
      const v = parseFloat(weight);
      if (u === "kg" && weightUnit === "lbs") setWeight((v * 0.453592).toFixed(1));
      if (u === "lbs" && weightUnit === "kg")  setWeight((v * 2.20462).toFixed(1));
    }
    setWeightUnit(u);
  };

  // When switching height unit, convert value
  const switchHeightUnit = (u) => {
    if (height) {
      if (u === "cm" && heightUnit === "ft") {
        // parse e.g. "5'9" -> cm
        const m = height.match(/(\d+)[^0-9]*(\d*)/);
        if (m) {
          const totalIn = parseInt(m[1]) * 12 + parseInt(m[2] || 0);
          setHeight(Math.round(totalIn * 2.54).toString());
        }
      } else if (u === "ft" && heightUnit === "cm") {
        const cm = parseFloat(height);
        if (!isNaN(cm)) {
          const totalIn = cm / 2.54;
          const ft = Math.floor(totalIn / 12);
          const ins = Math.round(totalIn % 12);
            setHeight(ft + "'" + ins);
        }
      }
    }
    setHeightUnit(u);
  };

  // Auto-format height in ft: after first digit add apostrophe and keep typing inches
  const handleHeightChange = (val) => {
    if (heightUnit === "ft") {
      // Remove all non-digit chars except apostrophe
      const raw = val.replace(/[^0-9']/g, "");
      const digits = raw.replace(/'/g, "");
      if (digits.length === 0) { setHeight(""); return; }
      if (digits.length === 1) {
        // One digit typed: show as "X'" 
        setHeight(digits + "'");
      } else {
        // 2+ digits: first is feet, rest are inches
        setHeight(digits[0] + "'" + digits.slice(1));
      }
    } else {
      setHeight(val.replace(/[^0-9]/g, ""));
    }
  };

  const handleContinue = () => {
    const weightKg = toKg(weight, weightUnit);
    const heightCm = toCm(height, heightUnit);
    const ageVal   = calcAgeFromDob(dob);
    try {
      localStorage.setItem("vtrx_weight_unit", weightUnit);
      localStorage.setItem("vtrx_height_unit", heightUnit);
      if (dob) localStorage.setItem("vtrx_user_dob", dob);
    } catch {}
    setUser(u=>({...u, weight: weightKg, height: heightCm, dob, age: ageVal, gender}));
    onContinue();
  };

  const field = { width:"100%",background:"rgba(255,255,255,0.92)",borderRadius:14,padding:"16px 18px",fontFamily:FONT,fontSize:16,fontWeight:600,color:"#111",outline:"none",border:"2px solid transparent",boxSizing:"border-box" };
  const lbl   = { fontFamily:FONT,fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.8)",letterSpacing:1.5,marginBottom:8,display:"block" };

  const UnitToggle = ({ units, current, onChange }) => (
    <div style={{ display:"flex",background:"rgba(255,255,255,0.1)",borderRadius:20,padding:3,marginBottom:10 }}>
      {units.map(u=>(
        <button key={u} onClick={()=>onChange(u)} style={{ flex:1,padding:"7px 0",borderRadius:16,border:"none",background:current===u?PRIMARY:"transparent",fontFamily:FONT,fontWeight:700,fontSize:12,color:current===u?"#fff":"rgba(255,255,255,0.55)",cursor:"pointer",transition:"all 0.2s" }}>{u}</button>
      ))}
    </div>
  );

  return (
    <Shell bg="https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=800&q=80"
           overlay="linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.88) 100%)">
      <NavBar title="Body Measurements" step={1} total={3} onBack={onBack} onSkip={onContinue}/>
      <div style={{ flex:1,overflowY:"auto",padding:"0 24px 40px" }}>

        {/* Weight */}
        <div style={{ marginBottom:22 }}>
          <span style={lbl}>BODYWEIGHT</span>
          <UnitToggle units={["lbs","kg"]} current={weightUnit} onChange={switchWeightUnit}/>
          <input value={weight} onChange={e=>setWeight(e.target.value.replace(/[^0-9.]/g,""))}
            placeholder={weightUnit==="lbs"?"160":"73"} inputMode="decimal" style={field}/>
        </div>

        {/* Height — single field, auto formats ft */}
        <div style={{ marginBottom:22 }}>
          <span style={lbl}>HEIGHT{heightUnit==="ft"?" — type feet then inches (e.g. 5'9)":""}</span>
          <UnitToggle units={["ft","cm"]} current={heightUnit} onChange={switchHeightUnit}/>
          <input value={height} onChange={e=>handleHeightChange(e.target.value)}
            placeholder={heightUnit==="ft"?"5'9":"178"} inputMode="numeric" style={field}/>
        </div>

        {/* Date of Birth */}
        <div style={{ marginBottom:22 }}>
          <span style={lbl}>DATE OF BIRTH</span>
          <input value={dob}
            placeholder="DD/MM/YYYY" inputMode="numeric"
            onFocus={e=>{ if(!dob) setDob(""); }}
            onChange={e=>{
              let v = e.target.value.replace(/[^0-9]/g,"");
              if (v.length > 2) v = v.slice(0,2)+"/"+v.slice(2);
              if (v.length > 5) v = v.slice(0,5)+"/"+v.slice(5);
              if (v.length > 10) v = v.slice(0,10);
              setDob(v);
            }}
            style={field}/>
        </div>

        {/* Gender */}
        <div style={{ marginBottom:22 }}>
          <span style={lbl}>SEX AT BIRTH</span>
          <div style={{ display:"flex",flexWrap:"wrap",gap:10 }}>
            {["Male","Female","Other","Prefer not to say"].map(g=>(
              <button key={g} onClick={()=>setGender(g)}
                style={{ padding:"12px 20px",borderRadius:50,border:`2px solid ${gender===g?PRIMARY:"rgba(255,255,255,0.25)"}`,background:gender===g?`${PRIMARY}22`:"rgba(255,255,255,0.08)",color:gender===g?PRIMARY:"rgba(255,255,255,0.85)",fontFamily:FONT,fontWeight:600,fontSize:13,cursor:"pointer",transition:"all 0.18s" }}>
                {g}
              </button>
            ))}
          </div>
        </div>

        {/* Goal Weight */}
        <div style={{ marginBottom:22 }}>
          <span style={lbl}>GOAL WEIGHT (optional)</span>
          <input value={goalW} onChange={e=>setGoalW(e.target.value.replace(/[^0-9.]/g,""))}
            placeholder={weightUnit==="lbs"?"e.g. 150":"e.g. 68"} inputMode="decimal" style={field}/>
        </div>

        {/* Body Fat */}
        <div style={{ marginBottom:28 }}>
          <span style={lbl}>BODY FAT % (optional)</span>
          <input value={bf} onChange={e=>setBf(e.target.value.replace(/[^0-9.]/g,""))}
            placeholder="e.g. 18" inputMode="decimal" style={field}/>
        </div>

        <CTA label="CONTINUE" onClick={handleContinue}/>
      </div>
    </Shell>
  );
}

function WorkoutTypeIcon({ type }) {
  const s = { width:18, height:18, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:"2" };
  if (type==="barbell"||type==="muscle") return <svg {...s}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
  if (type==="heart"||type==="cardio")   return <svg {...s}><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>;
  if (type==="rest"||type==="recovery")  return <svg {...s}><path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>;
  if (type==="run"||type==="hiit")       return <svg {...s}><circle cx="13" cy="4" r="2"/><path d="M10.5 20.5l1-4-2.5-2.5L11 9l4 3h4"/><path d="M7 20.5l2.5-6"/></svg>;
  if (type==="strength")                 return <svg {...s}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function WorkoutScreen({ onContinue, onBack }) {
  const { user, setUser } = useUser();
  const[goal,setGoal]=useState("");const[level,setLevel]=useState("");const[style,setStyle]=useState([]);const[days,setDays]=useState("");const[time,setTime]=useState("");const[location,setLocation]=useState("");const[equip,setEquip]=useState([]);
  return <Shell bg="https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.55) 30%,rgba(0,0,0,0.85) 100%)"><NavBar title="Customize Workout" step={2} total={3} onBack={onBack} onSkip={onContinue}/><div style={{ flex:1,overflowY:"auto",padding:"0 24px 24px" }}><Q n="1" text="What is your primary goal?" sub="(Select one)"/><ChipGroup options={["Build Muscle","Lose Weight","Stay Active","Improve Endurance","Get Toned"]} value={goal} onChange={setGoal}/><Q n="2" text="What is your experience level?" sub="(Select one)"/><ChipGroup options={["Beginner","Intermediate","Advanced","Professional"]} value={level} onChange={setLevel}/><Q n="3" text="What is your preferred workout style?" sub="(Pick 1–3)"/><ChipGroup options={["Strength Training","Cardio","HIIT","Bodyweight","Functional Fitness"]} value={style} onChange={setStyle} multi/><Q n="4" text="How many times do you want to work out each week?"/><ChipGroup options={["1–2 Days/Week","3–4 Days/Week","5+ Days/Week"]} value={days} onChange={setDays}/><Q n="5" text="Where do you usually work out?" sub="(Select one)"/><ChipGroup options={["Full Gym","Home","Outdoors","Mix of both"]} value={location} onChange={setLocation}/><Q n="6" text="What equipment do you have access to?" sub="(Select all that apply)"/><ChipGroup options={["Dumbbells","Barbell & Plates","Pull-up Bar","Resistance Bands","Kettlebells","Bench","Cable Machine","No Equipment"]} value={equip} onChange={setEquip} multi/><Q n="7" text="How much time can you dedicate to fitness daily?"/><ChipGroup options={["15–30 minutes","30–45 minutes","45–60 minutes","60+ minutes"]} value={time} onChange={setTime}/><div style={{marginTop:28}}><CTA label="CONTINUE" onClick={()=>{ const newPrefs={goal:goal||user.goal, fitnessLevel:level||user.fitnessLevel, workoutTime:time, workoutLocation:location, location:location, workoutStyle:style, equipment:equip, daysPerWeek:parseInt(days)||user.daysPerWeek}; setUser(u=>({...u,...newPrefs})); if(getAuthToken()){apiCall('/users/profile',{method:'PUT',skipAuthRedirect:true,body:JSON.stringify({goal:newPrefs.goal,fitnessLevel:newPrefs.fitnessLevel,daysPerWeek:newPrefs.daysPerWeek,equipment:newPrefs.equipment,location:newPrefs.location,sessionDuration:time,preferredStyles:Array.isArray(style)?style:[style].filter(Boolean)})}).catch(()=>{}); } onContinue(); }}/></div></div></Shell>;
}
function NutritionScreen({ onContinue, onBack }) {
  const { setUser } = useUser();
  const[want,setWant]=useState("");const[nutGoal,setNutGoal]=useState("");const[track,setTrack]=useState("");const[diet,setDiet]=useState([]);const[meals,setMeals]=useState("");
  const GOAL_MAP  = {"Lose Fat":"lose_fat","Build Muscle":"build_muscle","Maintain":"maintain","Eat clean":"eat_clean","Improve Energy":"improve_energy"};
  const TRACK_MAP = {"Yes, both":"yes_both","Only Calories":"only_calories","No, but I'd like to":"no_but_interested","No, not interested":"no_not_interested"};
  const DIET_MAP  = {"Vegan":"vegan","Vegetarian":"vegetarian","Gluten Free":"gluten_free","Dairy-Free":"dairy_free","No Peanuts":"no_peanuts","Other?":"other"};
  const MEALS_MAP = {"2 meals":"2","3 meals":"3","4+ meals":"4_plus","It varies":"varies"};
  return <Shell bg="https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,10,20,0.45) 0%,rgba(0,10,20,0.55) 30%,rgba(0,10,20,0.9) 100%)"><NavBar title="Customize Nutrition" step={3} total={3} onBack={onBack} onSkip={onContinue}/><div style={{ flex:1,overflowY:"auto",padding:"0 24px 24px" }}><Q n="1" text="Would you like meal suggestions based on your goals?"/><ChipGroup options={["Yes","No"]} value={want} onChange={setWant}/><Q n="2" text="What's your main nutrition goal?"/><ChipGroup options={["Lose Fat","Build Muscle","Maintain","Eat clean","Improve Energy"]} value={nutGoal} onChange={setNutGoal}/><Q n="3" text="Do you track your calories or macros?"/><ChipGroup options={["Yes, both","Only Calories","No, but I'd like to","No, not interested"]} value={track} onChange={setTrack}/><Q n="4" text="Do you have any dietary preferences or restrictions?"/><ChipGroup options={["Vegan","Vegetarian","Gluten Free","Dairy-Free","No Peanuts","Other?"]} value={diet} onChange={setDiet} multi/><Q n="5" text="How many meals do you eat daily?"/><ChipGroup options={["2 meals","3 meals","4+ meals","It varies"]} value={meals} onChange={setMeals}/><div style={{marginTop:28}}><CTA label="CONTINUE" onClick={()=>{ const prefs={ wantsMealSuggestions:want==="Yes", nutritionGoal:GOAL_MAP[nutGoal]||nutGoal||"maintain", trackingPreference:TRACK_MAP[track]||track||"no_not_interested", dietaryRestrictions:diet.map(d=>DIET_MAP[d]||d.toLowerCase().replace(/\s+/g,"_")), mealsPerDay:MEALS_MAP[meals]||meals||"3" }; setUser(u=>({...u,...prefs})); if(getAuthToken()){apiCall('/users/profile',{method:'PUT',skipAuthRedirect:true,body:JSON.stringify(prefs)}).catch(()=>{});} onContinue(); }}/></div></div></Shell>;
}
function PricingScreen({ onContinue, onBack }) {
  const subscribe = (plan) => {
    openPaymentSheet(plan);
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
        <button onClick={()=>{ if(selected==="premium") { openPaymentSheet(billingAnnual?"annual":"monthly"); return; } onContinue(); }}
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
  const { user } = useUser();
  const level    = user.fitnessLevel || user.level || "Beginner";
  const time     = user.workoutTime  || "25 min";
  const location = user.workoutLocation || "Home";
  const style    = Array.isArray(user.workoutStyle) ? (user.workoutStyle[0] || "Strength") : (user.workoutStyle || "Strength");
  const timeDisplay = time.includes("min") ? time : time + " min";
  const styleList   = Array.isArray(user.workoutStyle) && user.workoutStyle.length > 0 ? user.workoutStyle[0] : "Full Body";
  const workoutName = level + " " + styleList;
  return <Shell bg="https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&q=80" overlay="linear-gradient(180deg,rgba(0,0,0,0.5) 0%,rgba(0,0,0,0.6) 40%,rgba(0,0,0,0.94) 100%)"><div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px",textAlign:"center" }}><div style={{ width:100,height:100,borderRadius:"50%",background:"rgba(0,163,255,0.15)",border:`2.5px solid ${PRIMARY}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 28px",boxShadow:`0 0 50px rgba(0,163,255,0.4)`,opacity:v?1:0,transform:v?"scale(1)":"scale(0.6)",transition:"all 0.5s cubic-bezier(0.34,1.56,0.64,1)" }}><VTRXLogo size={44}/></div><div style={{ opacity:v?1:0,transform:v?"translateY(0)":"translateY(20px)",transition:"all 0.5s ease 0.25s" }}><div style={{ fontFamily:FONT,fontWeight:900,fontSize:26,color:"#fff",marginBottom:10,lineHeight:1.2 }}>Your Profile is Ready!</div><div style={{ fontFamily:FONT,fontSize:14,color:"rgba(255,255,255,0.65)",lineHeight:1.65,marginBottom:32 }}>VTRX has built your personalised training plan, meal of the day, and first workout — all based on your answers.</div></div><div style={{ width:"100%",background:"rgba(0,163,255,0.12)",border:"1.5px solid rgba(0,163,255,0.4)",borderRadius:20,padding:"20px 22px",marginBottom:28,opacity:v?1:0,transform:v?"translateY(0)":"translateY(20px)",transition:"all 0.5s ease 0.4s" }}><p style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:PRIMARY,letterSpacing:2,marginBottom:14 }}>YOUR FIRST WORKOUT IS READY</p><div style={{ display:"flex",alignItems:"center",gap:14 }}><div style={{ width:52,height:52,borderRadius:12,background:"rgba(0,163,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center" }}><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg></div><div style={{textAlign:"left"}}><p style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",margin:"0 0 3px" }}>{workoutName}</p><p style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.6)",margin:0 }}>{timeDisplay} · {location} · {style}</p></div></div></div><div style={{ width:"100%",opacity:v?1:0,transition:"opacity 0.5s ease 0.55s" }}><CTA label="LET'S GO" onClick={onFinish}/></div><p style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.4)",marginTop:16 }}>Day 1 streak starts now</p></div></Shell>;
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
  if (name==="Bench Press")    return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
  if (name==="Deadlift")       return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>;
  if (name==="5K Run")         return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
  if (name==="Squat")          return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><polyline points="17 21 12 13 7 21"/><polyline points="17 13 12 5 7 13"/></svg>;
  if (name==="Pull-ups")       return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><path d="M6 2v6"/><path d="M18 2v6"/><path d="M3 8h18"/></svg>;
  if (name==="Shoulder Press") return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><polyline points="12 19 12 5"/><polyline points="5 12 12 5 19 12"/></svg>;
  return <svg width={W} height={H} viewBox={V} fill={F} stroke="white" strokeWidth={SW}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
// Consistent per-exercise colour — same exercise always gets the same colour everywhere
const PR_PALETTE = ["#EF4444","#22C55E","#00A3FF","#F97316","#8B5CF6","#EAB308","#06B6D4","#F59E0B"];
const PR_EXERCISE_COLORS = {
  "Bench Press":    "#EF4444",
  "Deadlift":       "#22C55E",
  "5K Run":         "#00A3FF",
  "Squat":          "#F97316",
  "Pull-ups":       "#8B5CF6",
  "Shoulder Press": "#EAB308",
};
function getPRColor(name, fallbackIdx=0) {
  return PR_EXERCISE_COLORS[name] || PR_PALETTE[fallbackIdx % PR_PALETTE.length];
}

// Placeholder shells — shown for new users with no real PRs yet.
// Values and dates are intentionally blank; they fill in once real records exist.
const RECORDS = [
  { name:"Bench Press",    history:[], dates:[] },
  { name:"Deadlift",       history:[], dates:[] },
  { name:"5K Run",         history:[], dates:[] },
  { name:"Squat",          history:[], dates:[] },
  { name:"Pull-ups",       history:[], dates:[] },
  { name:"Shoulder Press", history:[], dates:[] },
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
      <img src={img} alt="" width={80} height={80} loading="lazy" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
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
function CalendarPage({ onBack, loggedWorkouts=[] }) {
  const { dark } = useTheme();
  const calScrollRef = useScrollPos("calendar");
  const T = dark ? DARK : LIGHT;
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState(null);
  const [animKey, setAnimKey]         = useState(0);
  const [slideDir, setSlideDir]       = useState(0);
  const [calHistory, setCalHistory]   = useState([]);
  const touchStartX = useRef(null);
  const MAX_PAST = 3; // can go back 3 months, not forward past current

  useEffect(()=>{
    apiCall('/workouts/history?limit=90')
      .then(d=>{ if(d?.data?.logs) setCalHistory(d.data.logs); })
      .catch(()=>{});
  }, []);

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

  const now = new Date();
  const displayDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const monthName = displayDate.toLocaleString("default", { month: "long", year: "numeric" });

  const firstDOW = displayDate.getDay();
  const daysInMonth = new Date(displayDate.getFullYear(), displayDate.getMonth() + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDOW; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  // Build per-day arrays of workouts for the displayed month
  const inMonth = h => { const d=new Date(h.completedAt||h.date); return d.getMonth()===displayDate.getMonth()&&d.getFullYear()===displayDate.getFullYear(); };
  const liveCalData = {};
  calHistory.filter(inMonth).forEach(h => {
    const day = new Date(h.completedAt || h.date).getDate();
    if (!liveCalData[day]) liveCalData[day] = [];
    liveCalData[day].push({ name:h.name||"Workout", type:(h.type||"strength").toLowerCase(), duration:h.duration||0, cal:h.caloriesBurned||0 });
  });
  loggedWorkouts.forEach(lw => {
    const d = new Date(lw.date);
    if (d.getMonth()===displayDate.getMonth()&&d.getFullYear()===displayDate.getFullYear()) {
      const day = d.getDate();
      if (!liveCalData[day]) liveCalData[day] = [];
      liveCalData[day].push({ name:lw.name||"Workout", type:lw.type||"strength", duration:lw.duration||0, cal:lw.cal||0 });
    }
  });

  const monthCal        = calHistory.filter(inMonth);
  const monthlyWorkouts = Object.keys(liveCalData).length;
  const avgCal  = monthCal.length > 0 ? Math.round(monthCal.reduce((s,h)=>s+(h.caloriesBurned||0),0) / monthCal.length) : 0;
  const avgMins = monthCal.length > 0 ? Math.round(monthCal.reduce((s,h)=>s+(h.duration||0),0)      / monthCal.length) : 0;
  // Rest days = past days in the month that had no workout
  const today2 = new Date();
  const isCurrentMonth = displayDate.getMonth()===today2.getMonth()&&displayDate.getFullYear()===today2.getFullYear();
  const daysElapsed = isCurrentMonth ? today2.getDate() : daysInMonth;
  const restDays = Math.max(0, daysElapsed - monthlyWorkouts);

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
            <button onClick={()=>changeMonth(monthOffset-1)} disabled={monthOffset<=-MAX_PAST}
              style={{ width:34,height:34,borderRadius:"50%",background:monthOffset<=-MAX_PAST?"#111":CARD,border:`1px solid ${monthOffset<=-MAX_PAST?"#1a1a1a":BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:monthOffset<=-MAX_PAST?"not-allowed":"pointer",transition:"all 0.2s" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={monthOffset<=-MAX_PAST?"#2a2a2a":"#888"} strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button onClick={()=>changeMonth(monthOffset+1)} disabled={monthOffset>=0}
              style={{ width:34,height:34,borderRadius:"50%",background:monthOffset>=0?"#111":CARD,border:`1px solid ${monthOffset>=0?"#1a1a1a":BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:monthOffset>=0?"not-allowed":"pointer",transition:"all 0.2s" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={monthOffset>=0?"#2a2a2a":"#888"} strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
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
              const dayWorkouts = liveCalData[day] || [];
              const type  = dayWorkouts[0]?.type;
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
        {selectedDay ? (
          <div style={{ animation:"fadeUp 0.3s ease both" }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:14 }}>
              {displayDate.toLocaleString("default",{month:"long"})} {selectedDay}
            </div>
            {(liveCalData[selectedDay]||[]).length > 0 ? (
              (liveCalData[selectedDay]||[]).map((w,wi)=>(
                <div key={wi} style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:12 }}>
                  <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
                    <div>
                      <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff",marginBottom:6 }}>{w.name}</div>
                      <TypeBadge type={w.type}/>
                    </div>
                  </div>
                  <div style={{ display:"flex",gap:0,borderRadius:14,overflow:"hidden",border:`1px solid ${BORDER}` }}>
                    {[
                      {lbl:"Duration", val:`${w.duration}m`, c:"#22C55E"},
                      {lbl:"Calories", val:w.cal,             c:"#EF4444"},
                    ].map((s,i,arr)=>(
                      <div key={i} style={{ flex:1,textAlign:"center",padding:"12px 6px",borderRight:i<arr.length-1?`1px solid ${BORDER}`:0 }}>
                        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:s.c,lineHeight:1,marginBottom:4 }}>{s.val}</div>
                        <div style={{ fontFamily:FONT,fontSize:10,color:"#888888",letterSpacing:0.5 }}>{s.lbl}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"32px 18px",textAlign:"center",marginBottom:12 }}>
                <div style={{ fontFamily:FONT,fontSize:16,color:"#555",marginBottom:6 }}>Rest Day</div>
                <div style={{ fontFamily:FONT,fontSize:13,color:"#444" }}>No workout logged on this day</div>
              </div>
            )}
            <button onClick={()=>setSelectedDay(null)} style={{ width:"100%",padding:"13px 0",borderRadius:50,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888888",cursor:"pointer" }}>
              ← Back to monthly view
            </button>
          </div>
        ) : (
          <div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:14 }}>Monthly Stats</div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
              {[
                {svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>, val:avgCal, lbl:"Avg Calories", bg:"#DC2626"},
                {svg:<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, val:avgMins, lbl:"Avg Minutes", bg:"#16A34A"},
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
function WorkoutHistoryPage({ onBack, onUpgrade }) {
  const [history,  setHistory]  = React.useState([]);
  const [loading,  setLoading]  = React.useState(true);
  React.useEffect(()=>{
    setLoading(true);
    apiCall("/workouts/history?limit=30")
      .then(res=>{
        if (res?.data?.logs) setHistory(res.data.logs);
        else setHistory([]);
      })
      .catch(()=>setHistory([]))
      .finally(()=>setLoading(false));
  }, []);

  // Map backend fields to display fields
  const mapped = history.map(h=>({
    id:       h.id,
    name:     h.name || "Workout",
    type:     (h.type||"strength").toLowerCase(),
    duration: h.duration || 0,
    cal:      h.caloriesBurned || 0,
    date:     h.completedAt ? new Date(h.completedAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}) : "–",
  }));
  const { dark } = useTheme();
  const histScrollRef = useScrollPos("workout-history");
  const T = dark ? DARK : LIGHT;
  const [filter, setFilter] = useState("all");
  const filters = ["all","strength","cardio","hiit"];
  const { isPremium: histPremium } = useUser();
  const allHistory = filter==="all" ? mapped : mapped.filter(h=>h.type===filter);
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
            <button onClick={onUpgrade} style={{ background:"none",border:"none",cursor:"pointer",fontFamily:FONT,fontWeight:700,fontSize:11,color:PRIMARY,letterSpacing:0.5,padding:0 }}>PREMIUM →</button>
          </div>
        )}
        {loading ? <div style={{textAlign:"center",padding:"40px 0",fontFamily:FONT,color:"#555"}}>Loading...</div> : filtered.length===0 ? <div style={{textAlign:"center",padding:"40px 0",fontFamily:FONT,color:"#555"}}>No workouts yet. Complete your first workout!</div> : filtered.map((h,i)=>(
          <div key={i} style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:12,display:"flex",alignItems:"center",gap:14,animation:`fadeUp 0.3s ease ${i*0.05}s both` }}>
            <div style={{ width:46,height:46,borderRadius:14,background:`${TYPE_COLOR[h.type]}22`,border:`1.5px solid ${TYPE_COLOR[h.type]}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:22,color:TYPE_COLOR[h.type] }}>
              {h.type==="strength"
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
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
  const T = dark ? DARK : LIGHT;
  const recScrollRef = useScrollPos("personal-records");
  const [search, setSearch]   = useState("");
  const [selected, setSelected] = useState(null);
  const [records, setRecords]   = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(()=>{
    apiCall('/users/personal-records')
      .then(d=>{ if(d?.data?.records) setRecords(d.data.records); })
      .catch(()=>{})
      .finally(()=>setLoading(false));
  }, []);

  const filtered = records.filter(r => r.exerciseName.toLowerCase().includes(search.toLowerCase()));
  const rec      = selected ? records.find(r => r.exerciseName === selected) : null;

  const fmtWeight = (w) => w ? `${w} lbs` : '—';
  const fmtDate   = (d) => d ? new Date(d).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—';

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"50px 18px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
        {rec ? <BackBtn onBack={()=>setSelected(null)}/> : <BackBtn onBack={onBack}/>}
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",letterSpacing:2 }}>{rec?"RECORD DETAIL":"PERSONAL RECORDS"}</div>
        <div style={{ width:38 }}/>
      </div>

      {!rec ? (
        <div ref={recScrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 32px" }}>
          <div style={{ background:CARD,borderRadius:50,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",padding:"0 18px",height:50,marginBottom:20 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search exercises..." style={{ flex:1,background:"none",border:"none",fontFamily:FONT,fontSize:14,color:"#fff",outline:"none",marginLeft:10 }}/>
          </div>

          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#444",letterSpacing:1,marginBottom:12 }}>YOUR BEST PERFORMANCES</div>

          {loading && (
            <div style={{ textAlign:"center",padding:"40px 0" }}>
              <div style={{ width:32,height:32,border:`3px solid ${BORDER}`,borderTop:`3px solid ${PRIMARY}`,borderRadius:"50%",margin:"0 auto",animation:"spin 0.8s linear infinite" }}/>
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div style={{ textAlign:"center",padding:"60px 20px" }}>
              <div style={{ width:64,height:64,borderRadius:"50%",background:`${PRIMARY}18`,border:`1px solid ${PRIMARY}33`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px" }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
              </div>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff",marginBottom:8 }}>No records yet</div>
              <div style={{ fontFamily:FONT,fontSize:14,color:"#666",lineHeight:1.6 }}>
                {records.length === 0
                  ? "Complete your first workout to set your baseline personal records."
                  : "No records match your search."}
              </div>
            </div>
          )}

          {!loading && filtered.map((r,i)=>{
            const color = getPRColor(r.exerciseName, i);
            return (
              <div key={r.id} onClick={()=>setSelected(r.exerciseName)}
                style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:12,display:"flex",alignItems:"center",gap:14,cursor:"pointer",animation:`fadeUp 0.3s ease ${i*0.06}s both` }}>
                <div style={{ width:46,height:46,borderRadius:"50%",background:`${color}22`,border:`1px solid ${color}44`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",marginBottom:3 }}>{r.exerciseName}</div>
                  <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>Personal Best · {fmtDate(r.achievedAt)}</div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color }}>{fmtWeight(r.weight)}</div>
                  {r.reps && <div style={{ fontFamily:FONT,fontSize:11,color:"#555",marginTop:2 }}>{r.reps} reps</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ flex:1,overflowY:"auto",padding:"0 16px 32px",animation:"fadeUp 0.3s ease both" }}>
          {(() => {
            const idx   = records.findIndex(r=>r.exerciseName===selected);
            const color = getPRColor(selected, idx);
            return (
              <>
                <div style={{ background:`linear-gradient(135deg,${color}22,${color}11)`,border:`1.5px solid ${color}44`,borderRadius:22,padding:"28px 24px",textAlign:"center",marginBottom:16 }}>
                  <div style={{ width:64,height:64,borderRadius:"50%",background:`${color}22`,border:`1px solid ${color}44`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px" }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
                  </div>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:"#fff",marginBottom:6 }}>{rec.exerciseName}</div>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:48,color,lineHeight:1,marginBottom:8 }}>{fmtWeight(rec.weight)}</div>
                  {rec.reps && <div style={{ fontFamily:FONT,fontSize:14,color:"rgba(255,255,255,0.6)",marginBottom:4 }}>{rec.reps} reps</div>}
                  <div style={{ fontFamily:FONT,fontSize:13,color:"rgba(255,255,255,0.5)" }}>Achieved {fmtDate(rec.achievedAt)}</div>
                </div>
                <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"18px" }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#444",letterSpacing:1,marginBottom:14 }}>STATS</div>
                  {[
                    {lbl:"Personal Best",  val:fmtWeight(rec.weight), c:color},
                    {lbl:"Best Reps",      val:rec.reps ? `${rec.reps} reps` : '—', c:"#fff"},
                    {lbl:"Last Achieved",  val:fmtDate(rec.achievedAt), c:"#fff"},
                  ].map((s,i,arr)=>(
                    <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:i<arr.length-1?12:0,borderBottom:i<arr.length-1?`1px solid ${BORDER}`:0,marginBottom:i<arr.length-1?12:0 }}>
                      <span style={{ fontFamily:FONT,fontSize:14,color:"#aaa" }}>{s.lbl}</span>
                      <span style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:s.c }}>{s.val}</span>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
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
  if (name==="Push / Pull / Legs") return <svg width={W} height={H} viewBox={V} fill={F} stroke="currentColor" strokeWidth={SW}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
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

const WEEKLY_WORKOUTS = [
  { day:"Day 1", name:"Upper Body Strength", type:"STRENGTH", duration:45, cal:340, exercises:[ {n:1,name:"Bench Press",      detail:"4 sets × 8 reps" }, {n:2,name:"Pull-ups",         detail:"4 sets × 12 reps"}, {n:3,name:"Shoulder Press",   detail:"3 sets × 10 reps"} ] },
  { day:"Day 2", name:"HIIT Cardio Burn",    type:"CARDIO",   duration:30, cal:280, exercises:[ {n:1,name:"Burpees",           detail:"3 sets × 15 reps"}, {n:2,name:"Jump Squats",      detail:"3 sets × 20 reps"}, {n:3,name:"Mountain Climbers", detail:"3 sets × 30s"   } ] },
  { day:"Day 3", name:"Leg Day",             type:"STRENGTH", duration:50, cal:380, exercises:[ {n:1,name:"Squats",            detail:"4 sets × 10 reps"}, {n:2,name:"Romanian DL",     detail:"3 sets × 10 reps"}, {n:3,name:"Leg Press",        detail:"3 sets × 12 reps"} ] },
  { day:"Day 4", name:"Push Day",            type:"STRENGTH", duration:45, cal:320, exercises:[ {n:1,name:"Incline Press",     detail:"4 sets × 10 reps"}, {n:2,name:"Dips",             detail:"3 sets × 12 reps"}, {n:3,name:"Tricep Ext",       detail:"3 sets × 15 reps"} ] },
  { day:"Day 5", name:"Full Body HIIT",      type:"HIIT",     duration:35, cal:420, exercises:[ {n:1,name:"Deadlifts",         detail:"3 sets × 8 reps" }, {n:2,name:"Box Jumps",       detail:"3 sets × 10 reps"}, {n:3,name:"Plank",            detail:"3 sets × 60s"   } ] },
];

const TODAY_IDX = new Date().getDay() === 0 ? 6 : new Date().getDay(); // tomorrow's session


// ChipSel — shared chip selector component
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

function CustomizePage({ onBack }) {
  const [editDay, setEditDay] = useState(null);
  const [programme, setProgramme] = useState(
    WEEKLY_WORKOUTS.map(w=>({ ...w, exercises:[...w.exercises] }))
  );
  const [saved, setSaved] = useState(false);
  const [env2, setEnv2]   = useState("Full Gym");
  const [equip, setEquip] = useState([]);

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


function WeightsHub({ onLogout=null, onNavigate=null, loggedWorkouts=[] }){
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const { user: wUser } = useUser();
  const [subPage, setSubPage] = useState(null);
  const [wIdx, setWIdx] = useState(TODAY_IDX);
  const [weekSchedule,    setWeekSchedule]    = useState([]);
  const [expandedId,      setExpandedId]      = useState(null);
  const [moveEntry,       setMoveEntry]       = useState(null);
  const [replaceEntry,    setReplaceEntry]    = useState(null);
  const [allWorkouts,     setAllWorkouts]     = useState([]);
  const [replaceSelected, setReplaceSelected] = useState(null);
  const [replaceLoading,  setReplaceLoading]  = useState(false);
  const [moveTargetDate,  setMoveTargetDate]  = useState(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [hubStats,         setHubStats]         = useState(null);
  const [previewPRs,       setPreviewPRs]       = useState([]);
  useEffect(()=>{
    const now = Date.now();
    if (_weightsCache.fetchedAt && (now - _weightsCache.fetchedAt) < CACHE_TTL_MS && _weightsCache.data) {
      const { schedule, workouts, stats, prs } = _weightsCache.data;
      if (schedule) setWeekSchedule(schedule);
      if (workouts) setAllWorkouts(workouts);
      if (stats)    setHubStats(stats);
      if (prs)      setPreviewPRs(prs);
      return;
    }
    setScheduleLoading(true);
    const newData = {};
    Promise.all([
      apiCall('/workouts/schedule').then(d=>{ if(d?.data?.schedule){ setWeekSchedule(d.data.schedule); newData.schedule=d.data.schedule; } }).catch(()=>{}),
      apiCall('/workouts?limit=20').then(d=>{ if(d?.data?.workouts){ setAllWorkouts(d.data.workouts); newData.workouts=d.data.workouts; } }).catch(()=>{}),
      apiCall('/workouts/stats').then(d=>{ if(d?.data?.stats){ setHubStats(d.data.stats); newData.stats=d.data.stats; } }).catch(()=>{}),
      apiCall('/users/personal-records').then(d=>{ if(d?.data?.records){ setPreviewPRs(d.data.records); newData.prs=d.data.records; } }).catch(()=>{}),
    ]).finally(()=>{
      _weightsCache.data = newData;
      _weightsCache.fetchedAt = Date.now();
      setScheduleLoading(false);
    });
  }, []);
  const weightsScrollRef = useScrollPos("weights-hub");
  const goBack = () => {
    setSubPage(null);
    requestAnimationFrame(()=>{
      if (weightsScrollRef.current && _scrollStore["weights-hub"]) {
        weightsScrollRef.current.scrollTop = _scrollStore["weights-hub"];
      }
    });
  };
  useEffect(() => {
    if (!subPage) return;
    _backHandler = goBack;
    return () => { _backHandler = null; };
  }, [subPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const w  = WEEKLY_WORKOUTS[wIdx % WEEKLY_WORKOUTS.length] || WEEKLY_WORKOUTS[0];
  const typeColors = { "STRENGTH":PRIMARY, "CARDIO":"#F59E0B", "HIIT":"#6366F1", "REST":"#374151", "MOBILITY":"#22C55E" };
  const tc = typeColors[w.type] || PRIMARY;
  const [monthOffset, setMonthOffset] = useState(0);
  const swipeStartX = useRef(null);

  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const currentMonthIdx = (new Date().getMonth() + monthOffset + 120) % 12;
  const monthName = months[currentMonthIdx];

  // Per-month stats — current month from API, older months from static fallback
  const MONTH_STATS_FALLBACK = {
    "-1": { days:"16/16", streak:"4 week", rate:"100%", pct:100, label:"Completed!" },
    "-2": { days:"14/16", streak:"2 week", rate:"88%",  pct:88,  label:"Great month" },
    "-3": { days:"11/16", streak:"1 week", rate:"69%",  pct:69,  label:"Keep going"  },
  };
  const stats = monthOffset === 0 && hubStats ? (() => {
    const completed = hubStats.monthlyCompletedDays || 0;
    const target    = Math.max(1, (hubStats.daysPerWeek || 3) * 4);
    const pct       = Math.min(100, Math.round((completed / target) * 100));
    const streak    = hubStats.currentStreak || 0;
    return {
      days:   `${completed}/${target}`,
      streak: `${streak} day${streak !== 1 ? 's' : ''}`,
      rate:   `${pct}%`,
      pct,
      label:  pct >= 100 ? "Completed!" : "In progress",
    };
  })() : MONTH_STATS_FALLBACK[String(monthOffset)] || { days:"0/16", streak:"0 day", rate:"0%", pct:0, label:"No data" };

  // Day-label helper: "Day 1", "Day 2" … based on sorted schedule order
  const sortedForDayLabels = React.useMemo(
    () => [...weekSchedule].sort((a,b) => new Date(a.scheduledDate) - new Date(b.scheduledDate)),
    [weekSchedule]
  );
  const getDayLabel = (entry) => {
    const idx = sortedForDayLabels.findIndex(s => s.id === entry.id);
    return idx >= 0 ? `Day ${idx + 1}` : "";
  };
  // Progress-based day counter: completions + 1, not schedule position
  const completedCount = weekSchedule.filter(s => s.status === 'COMPLETED').length;
  const planAllDone = weekSchedule.length > 0 && completedCount >= weekSchedule.length;
  const upNextLabel = planAllDone ? 'PLAN COMPLETE 🎉' : `UP NEXT · DAY ${completedCount + 1}`;

  // Swipe handlers for monthly card
  const onMonthSwipeStart = (e) => { swipeStartX.current = e.touches[0].clientX; };
  const onMonthSwipeEnd   = (e) => {
    if (!swipeStartX.current) return;
    const dx = e.changedTouches[0].clientX - swipeStartX.current;
    if (Math.abs(dx) > 50) setMonthOffset(o => dx < 0 ? o+1 : o-1);
    swipeStartX.current = null;
  };


  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>

      {/* ── TOP BAR ── */}
      <div style={{ padding:"50px 18px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          <div style={{ width:42,height:42,borderRadius:"50%",background:PRIMARY,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
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

        {/* ── WEEKLY PLAN ── */}
        {(()=>{
          const TYPE_C = { STRENGTH:PRIMARY, CARDIO:"#F59E0B", HIIT:"#6366F1", RECOVERY:"#22C55E", MOBILITY:"#22C55E" };

          const refreshSchedule = () => {
            apiCall('/workouts/schedule')
              .then(d=>{ if(d?.data?.schedule) setWeekSchedule(d.data.schedule); })
              .catch(()=>{});
          };

          const handleMove = async () => {
            if (!moveEntry || !moveTargetDate) return;
            try {
              await apiCall(`/workouts/schedule/${moveEntry.id}/move`, { method:'PATCH', body:JSON.stringify({ targetDate: moveTargetDate }) });
              refreshSchedule();
            } catch {}
            setMoveEntry(null);
            setMoveTargetDate(null);
          };

          const handleReplace = async () => {
            if (!replaceEntry) return;
            setReplaceLoading(true);
            try {
              const result = await apiCall('/workouts/generate-session', { method:'POST', body:JSON.stringify({ scheduleId: replaceEntry.id }) });
              if (result?.data?.scheduleEntry) {
                setWeekSchedule(prev => prev.map(s => s.id === replaceEntry.id ? result.data.scheduleEntry : s));
              } else {
                refreshSchedule();
              }
            } catch { refreshSchedule(); }
            setReplaceLoading(false);
            setReplaceEntry(null);
            setReplaceSelected(null);
          };

          const today = new Date();
          today.setHours(0,0,0,0);
          const upcoming2 = weekSchedule.filter(s=>{ const d=new Date(s.scheduledDate); d.setHours(0,0,0,0); return d>=today; });
          const past2     = weekSchedule.filter(s=>{ const d=new Date(s.scheduledDate); d.setHours(0,0,0,0); return d<today; });
          const nextEntry = upcoming2[0] || null;
          const otherEntries = [...(nextEntry ? upcoming2.slice(1) : []), ...past2];

          return (
            <>
              {/* Section header */}
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",letterSpacing:1 }}>THIS WEEK'S PLAN</div>
                <button onClick={refreshSchedule} style={{ background:"none",border:"none",cursor:"pointer",padding:4 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
                </button>
              </div>

              {/* Empty state */}
              {weekSchedule.length===0 && !scheduleLoading && (
                <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"28px 20px",marginBottom:14,textAlign:"center" }}>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",marginBottom:8 }}>No Workouts Scheduled</div>
                  <div style={{ fontFamily:FONT,fontSize:13,color:"#555" }}>Your weekly plan will appear here</div>
                </div>
              )}
              {weekSchedule.length===0 && scheduleLoading && (
                <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"28px 20px",marginBottom:14,textAlign:"center" }}>
                  <div style={{ fontFamily:FONT,fontSize:13,color:"#555" }}>Loading schedule...</div>
                </div>
              )}

              {/* UP NEXT card */}
              {nextEntry && (()=>{
                const nc = TYPE_C[nextEntry.workout.type] || PRIMARY;
                const exs = nextEntry.workout.exercises || [];
                return (
                  <div style={{ background:CARD,borderRadius:20,border:`1px solid ${nc}44`,marginBottom:12,overflow:"hidden" }}>
                    <div style={{ background:`linear-gradient(135deg,${nc}22,${nc}08)`,padding:"16px 16px 12px" }}>
                      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6 }}>
                        <div>
                          <div style={{ fontFamily:FONT,fontWeight:600,fontSize:10,color:nc,letterSpacing:1.5,marginBottom:3 }}>{upNextLabel}</div>
                          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff" }}>{generateWorkoutTitle(exs) || nextEntry.workout.name}</div>
                        </div>
                        <div style={{ background:nc,borderRadius:20,padding:"5px 12px",flexShrink:0 }}>
                          <span style={{ fontFamily:FONT,fontWeight:800,fontSize:10,color:"#fff",letterSpacing:1 }}>{nextEntry.workout.type}</span>
                        </div>
                      </div>
                      <div style={{ fontFamily:FONT,fontSize:12,color:"#888" }}>{getDayLabel(nextEntry)} · {nextEntry.workout.duration} min · {nextEntry.workout.calories} cal</div>
                    </div>
                    {exs.length>0 && (
                      <div style={{ display:"flex",gap:4,padding:"12px 16px 0" }}>
                        {exs.slice(0,4).map((ex,i)=>(
                          <div key={i} style={{ flex:1,aspectRatio:"1",borderRadius:10,overflow:"hidden",background:"#1a1a1a" }}>
                            {ex.thumbnailUrl
                              ? <img src={ex.thumbnailUrl} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                              : <div style={{ width:"100%",height:"100%",background:`${nc}22` }}/>
                            }
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ padding:"12px 16px" }}>
                      {exs.map((ex,j)=>(
                        <div key={j} style={{ display:"flex",alignItems:"center",gap:10,paddingBottom:j<exs.length-1?10:0,marginBottom:j<exs.length-1?10:0,borderBottom:j<exs.length-1?`1px solid ${BORDER}`:"none" }}>
                          <div style={{ width:28,height:28,borderRadius:8,background:nc,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:FONT,fontWeight:800,fontSize:11,color:"#fff" }}>{j+1}</div>
                          <div style={{ flex:1,minWidth:0 }}>
                            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{ex.name}</div>
                            {(()=>{const r=parseReps(ex.reps);const lbl=/^\d+s$/.test(r)?`${ex.sets} sets × ${r.replace(/s$/,' sec')}`:`${ex.sets} sets × ${r} reps`;return<div style={{fontFamily:FONT,fontSize:11,color:"#666"}}>{lbl}</div>;})()}
                          </div>
                          {ex.muscleGroup && <div style={{ fontFamily:FONT,fontSize:10,color:"#444",flexShrink:0 }}>{ex.muscleGroup}</div>}
                        </div>
                      ))}
                    </div>
                    <div style={{ padding:"0 16px 16px" }}>
                      <button onClick={()=>onNavigate&&onNavigate("workoutDetail", nextEntry.workout)} style={{ width:"100%",padding:"14px 0",borderRadius:50,background:nc,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",letterSpacing:1,marginBottom:8 }}>
                        START WORKOUT
                      </button>
                      <div style={{ display:"flex",gap:8 }}>
                        <button onClick={()=>{ setMoveEntry(nextEntry); setMoveTargetDate(null); }} style={{ flex:1,padding:"10px 0",borderRadius:50,background:"#1a1a1a",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:12,color:"#ccc",cursor:"pointer" }}>
                          MOVE
                        </button>
                        <button onClick={()=>{ setReplaceEntry(nextEntry); setReplaceSelected(null); }} style={{ flex:1,padding:"10px 0",borderRadius:50,background:"#1a1a1a",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:12,color:"#ccc",cursor:"pointer" }}>
                          REPLACE
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* MOVE MODAL */}
              {moveEntry && (
                <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:200,display:"flex",alignItems:"flex-end" }} onClick={()=>{ setMoveEntry(null); setMoveTargetDate(null); }}>
                  <div onClick={e=>e.stopPropagation()} style={{ width:"100%",background:"#111",borderRadius:"24px 24px 0 0",padding:"24px 20px 40px",maxHeight:"80vh",overflowY:"auto" }}>
                    <div style={{ width:40,height:4,borderRadius:2,background:"#333",margin:"0 auto 20px" }}/>
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff",marginBottom:4 }}>Move Workout</div>
                    <div style={{ fontFamily:FONT,fontSize:13,color:"#555",marginBottom:20 }}>{generateWorkoutTitle(moveEntry.workout.exercises) || moveEntry.workout.name}</div>
                    <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#666",letterSpacing:1,marginBottom:12 }}>SELECT TARGET DAY</div>
                    {weekSchedule.filter(s=>s.id!==moveEntry.id).map(s=>{
                      const sd = new Date(s.scheduledDate);
                      const sc = TYPE_C[s.workout.type]||PRIMARY;
                      const isMoveTarget = moveTargetDate===s.scheduledDate.split('T')[0];
                      return (
                        <div key={s.id} onClick={()=>setMoveTargetDate(s.scheduledDate.split('T')[0])} style={{ display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:14,marginBottom:8,background:isMoveTarget?`${sc}22`:"#1a1a1a",border:isMoveTarget?`1px solid ${sc}`:"1px solid #222",cursor:"pointer" }}>
                          <div style={{ width:44,textAlign:"center",flexShrink:0 }}>
                            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:isMoveTarget?"#fff":"#888" }}>{getDayLabel(s)}</div>
                            <div style={{ fontFamily:FONT,fontSize:10,color:"#444" }}>{sd.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
                          </div>
                          <div style={{ flex:1,minWidth:0 }}>
                            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:isMoveTarget?"#fff":"#666",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{generateWorkoutTitle(s.workout.exercises) || s.workout.name}</div>
                            <div style={{ fontFamily:FONT,fontSize:11,color:"#555" }}>Will swap ↔</div>
                          </div>
                          {isMoveTarget && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={sc} strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                        </div>
                      );
                    })}
                    <div style={{ display:"flex",gap:10,marginTop:8 }}>
                      <button onClick={()=>{ setMoveEntry(null); setMoveTargetDate(null); }} style={{ flex:1,padding:"14px 0",borderRadius:50,background:"#1a1a1a",border:"1px solid #333",fontFamily:FONT,fontWeight:700,fontSize:14,color:"#888",cursor:"pointer" }}>
                        CANCEL
                      </button>
                      <button onClick={handleMove} disabled={!moveTargetDate} style={{ flex:2,padding:"14px 0",borderRadius:50,background:moveTargetDate?PRIMARY:"#222",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:moveTargetDate?"#fff":"#444",cursor:moveTargetDate?"pointer":"default",letterSpacing:1 }}>
                        CONFIRM MOVE
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* REPLACE MODAL */}
              {replaceEntry && (
                <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:200,display:"flex",alignItems:"flex-end" }} onClick={()=>{ if(!replaceLoading){ setReplaceEntry(null); setReplaceSelected(null); } }}>
                  <div onClick={e=>e.stopPropagation()} style={{ width:"100%",background:"#111",borderRadius:"24px 24px 0 0",padding:"24px 20px 40px" }}>
                    <div style={{ width:40,height:4,borderRadius:2,background:"#333",margin:"0 auto 20px" }}/>
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff",marginBottom:4 }}>Replace Workout</div>
                    <div style={{ fontFamily:FONT,fontSize:13,color:"#555",marginBottom:24 }}>{generateWorkoutTitle(replaceEntry.workout.exercises) || replaceEntry.workout.name}</div>
                    <div style={{ background:"#1a1a1a",borderRadius:16,padding:"20px 16px",marginBottom:24,border:"1px solid #222" }}>
                      <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:12 }}>
                        <div style={{ width:40,height:40,borderRadius:12,background:`${PRIMARY}22`,border:`1px solid ${PRIMARY}44`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                        </div>
                        <div>
                          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff",letterSpacing:0.5 }}>PERSONALIZED WORKOUT</div>
                          <div style={{ fontFamily:FONT,fontSize:11,color:"#555",marginTop:2 }}>Built from your profile</div>
                        </div>
                      </div>
                      <div style={{ fontFamily:FONT,fontSize:13,color:"#777",lineHeight:1.6 }}>
                        A new workout will be generated for <span style={{ color:"#fff",fontWeight:700 }}>{getDayLabel(replaceEntry)}</span> using your fitness level, goal, and available equipment. Max 5 exercises.
                      </div>
                    </div>
                    <div style={{ display:"flex",gap:10 }}>
                      <button onClick={()=>{ if(!replaceLoading){ setReplaceEntry(null); setReplaceSelected(null); } }} style={{ flex:1,padding:"14px 0",borderRadius:50,background:"#1a1a1a",border:"1px solid #333",fontFamily:FONT,fontWeight:700,fontSize:14,color:"#888",cursor:replaceLoading?"not-allowed":"pointer",opacity:replaceLoading?0.5:1 }}>
                        CANCEL
                      </button>
                      <button onClick={handleReplace} disabled={replaceLoading} style={{ flex:2,padding:"14px 0",borderRadius:50,background:replaceLoading?"#222":PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:replaceLoading?"#555":"#fff",cursor:replaceLoading?"not-allowed":"pointer",letterSpacing:1 }}>
                        {replaceLoading ? 'GENERATING...' : 'GENERATE'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          );
        })()}

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
          {(()=>{
            const hasPRs = previewPRs.length > 0;
            const displayPRs = hasPRs
              ? previewPRs.slice(0,3).map((r,i)=>{
                  const name  = r.exerciseName || r.name || "Exercise";
                  const color = getPRColor(name, i);
                  return {
                    name,
                    color,
                    bg:    `${color}22`,
                    val:   r.weight ? `${r.weight} lbs` : (r.reps ? `${r.reps} reps` : "—"),
                    when:  r.achievedAt ? new Date(r.achievedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : null,
                  };
                })
              : RECORDS.slice(0,3).map((r,i)=>{
                  const color = getPRColor(r.name, i);
                  return { name:r.name, color, bg:`${color}22`, val:"—", when:null };
                });
            return displayPRs.map((r,i)=>(
              <div key={i} onClick={()=>setSubPage("records")} style={{ background:CARD2,borderRadius:14,padding:"14px 16px",marginBottom:i<displayPRs.length-1?10:0,display:"flex",alignItems:"center",gap:14,cursor:"pointer" }}>
                <div style={{ width:44,height:44,borderRadius:"50%",background:r.bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><RecordIcon name={r.name}/></div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",marginBottom:2 }}>{r.name}</div>
                  <div style={{ fontFamily:FONT,fontSize:12,color:"#888888" }}>{hasPRs ? "Personal Best" : "No record yet"}</div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:r.val==="—"?"#555":r.color }}>{r.val}</div>
                  {r.when && <div style={{ fontFamily:FONT,fontSize:11,color:"#444",marginTop:2 }}>{r.when}</div>}
                </div>
              </div>
            ));
          })()}
        </div>

      </div>
      {/* Sub-page overlays — WeightsHub stays mounted preserving scroll + state */}
      {subPage === "calendar"  && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><CalendarPage        onBack={goBack} loggedWorkouts={loggedWorkouts}/></div>}
      {subPage === "history"   && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><WorkoutHistoryPage  onBack={goBack} onUpgrade={()=>setSubPage('upgrade_from_history')}/></div>}
      {subPage === "records"   && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><PersonalRecordsPage onBack={goBack}/></div>}
      {subPage === "customize" && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><CustomizePage       onBack={goBack}/></div>}
      {subPage === "profile"   && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><ProfilePage         onBack={goBack} onLogout={()=>{ setSubPage(null); onLogout&&onLogout(); }}/></div>}
      {subPage === "upgrade"             && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><UpgradePlanPage onBack={goBack}/></div>}
      {subPage === "upgrade_from_history"&& <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><UpgradePlanPage onBack={()=>setSubPage('history')}/></div>}
    </div>


  );
}


// ─────────────────────────────────────────────────────────────────────────────
// ── NOTIFICATION DATA ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Notification icons rendered as SVG in NotificationsPage
function NotifIcon({ type }) {
  const p = { width:"18",height:"18",viewBox:"0 0 24 24",fill:"none",stroke:"#fff",strokeWidth:"2" };
  if (type==="workout")   return <svg width={p.width} height={p.height} viewBox={p.viewBox} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
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
  if (type==="workout") return <svg {...s}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
  if (type==="meal")    return <svg {...s}><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>;
  if (type==="trophy")  return <svg {...s}><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M18 2H6v7a6 6 0 0012 0V2z"/></svg>;
  if (type==="users")   return <svg {...s}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>;
  if (type==="tag")     return <svg {...s}><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function NotifSettingsPage({ onBack }) {
  const { dark } = useTheme();
  const notifScrollRef = useScrollPos("notif-settings");

  const [prefs, setPrefs]       = useState(null);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testSent, setTestSent] = useState(false);

  // Load preferences from backend
  useEffect(() => {
    apiCall('/notifications/preferences')
      .then(d => {
        if (d?.data?.preferences) setPrefs(d.data.preferences);
      })
      .catch(() => {
        // Fallback defaults if server unreachable
        setPrefs({
          workoutReminderOn: true, workoutReminderHour: 8,
          streakAlertOn: true, reengagementOn: true,
          milestoneOn: true, weeklyRecapOn: true, trialWarningOn: true,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        });
      });
  }, []);

  const toggle = async (key) => {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    await apiCall('/notifications/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: !prefs[key] }),
    }).catch(() => {});
  };

  const setReminderHour = async (h) => {
    const next = { ...prefs, workoutReminderHour: h };
    setPrefs(next);
    setSaving(true);
    await apiCall('/notifications/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ workoutReminderHour: h }),
    }).catch(() => {});
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const sendTest = async () => {
    setTesting(true);
    await apiCall('/notifications/test', { method: 'POST', body: JSON.stringify({ type: 'workout_reminder' }) }).catch(() => {});
    setTesting(false);
    setTestSent(true);
    setTimeout(() => setTestSent(false), 3000);
  };

  const Toggle = ({ k }) => (
    <button onClick={() => toggle(k)} style={{
      width:50, height:28, borderRadius:14, border:"none", cursor:"pointer",
      background: prefs?.[k] ? PRIMARY : "#374151",
      position:"relative", transition:"background 0.25s", flexShrink:0,
      opacity: prefs ? 1 : 0.4,
    }}>
      <div style={{
        width:22, height:22, borderRadius:"50%", background:"#fff",
        position:"absolute", top:3,
        left: prefs?.[k] ? 25 : 3,
        transition:"left 0.25s", boxShadow:"0 1px 4px rgba(0,0,0,0.3)",
      }}/>
    </button>
  );

  const HOUR_LABELS = [
    "12am","1am","2am","3am","4am","5am","6am","7am","8am","9am","10am","11am",
    "12pm","1pm","2pm","3pm","4pm","5pm","6pm","7pm","8pm","9pm","10pm","11pm",
  ];

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

        {/* Workout reminder time picker */}
        <div style={{ background:"#fff", borderRadius:20, padding:"18px 20px", marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
            <div style={{ width:48, height:48, borderRadius:"50%", background:PRIMARY, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <NotifSectionIcon type="workout"/>
            </div>
            <div>
              <div style={{ fontFamily:FONT, fontWeight:800, fontSize:16, color:"#111" }}>Workout Reminders</div>
              <div style={{ fontFamily:FONT, fontSize:12, color:"#888888", marginTop:2 }}>Get notified about your daily workout</div>
            </div>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div>
              <div style={{ fontFamily:FONT, fontWeight:600, fontSize:14, color:"#111" }}>Daily workout reminder</div>
              <div style={{ fontFamily:FONT, fontSize:12, color:"#888888", marginTop:2 }}>Only sent if you haven't trained yet</div>
            </div>
            <Toggle k="workoutReminderOn"/>
          </div>
          {prefs?.workoutReminderOn && (
            <div>
              <div style={{ fontFamily:FONT, fontWeight:600, fontSize:13, color:"#555", marginBottom:8 }}>
                Reminder time: <span style={{ color:PRIMARY, fontWeight:800 }}>{HOUR_LABELS[prefs?.workoutReminderHour ?? 8]}</span>
                {saving && <span style={{ color:"#aaa", fontWeight:400, marginLeft:8 }}>saving…</span>}
                {saved  && <span style={{ color:"#22C55E", fontWeight:400, marginLeft:8 }}>saved ✓</span>}
              </div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {[5,6,7,8,9,10,11,12,17,18,19,20].map(h => (
                  <button key={h} onClick={() => setReminderHour(h)} style={{
                    padding:"5px 11px", borderRadius:20, border:"none", cursor:"pointer",
                    background: (prefs?.workoutReminderHour ?? 8) === h ? PRIMARY : "#f0f0f0",
                    color: (prefs?.workoutReminderHour ?? 8) === h ? "#fff" : "#555",
                    fontFamily:FONT, fontWeight:700, fontSize:12,
                  }}>{HOUR_LABELS[h]}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <Section icon="trophy" iconBg="#22C55E" title="Streak Protection" sub="Alert at 6pm if your streak is at risk"
          rows={[{ key:"streakAlertOn", label:"Streak alert", sub:"Warn me if I haven't trained and my streak will break" }]}
        />
        <Section icon="users" iconBg="#F97316" title="Re-engagement" sub="Friendly nudge after 5+ days away"
          rows={[{ key:"reengagementOn", label:"Comeback reminders", sub:"Reach out if I've been quiet for a while" }]}
        />
        <Section icon="tag" iconBg="#A855F7" title="Milestones & Achievements" sub="Celebrate your wins"
          rows={[{ key:"milestoneOn", label:"Milestone celebrations", sub:"1st workout, 7-day streak, 30-day member and more" }]}
        />
        <Section icon="users" iconBg="#0EA5E9" title="Weekly Recap" sub="Sunday 10am progress summary"
          rows={[{ key:"weeklyRecapOn", label:"Weekly progress report", sub:"Sent Sunday at 10am only if you trained that week" }]}
        />
        <Section icon="tag" iconBg="#EF4444" title="Trial & Billing" sub="Never miss a payment deadline"
          rows={[{ key:"trialWarningOn", label:"Trial expiry warning", sub:"3 days and 24h before your trial ends" }]}
        />

        {/* Test notification */}
        <div style={{ background:"rgba(255,255,255,0.06)", borderRadius:20, padding:"16px 20px", marginTop:4 }}>
          <div style={{ fontFamily:FONT, fontWeight:700, fontSize:14, color:"#fff", marginBottom:6 }}>Test push notifications</div>
          <div style={{ fontFamily:FONT, fontSize:12, color:"rgba(255,255,255,0.55)", marginBottom:14 }}>
            Send yourself a test notification to confirm everything is working.
          </div>
          <button onClick={sendTest} disabled={testing || testSent} style={{
            width:"100%", padding:"12px", borderRadius:14, border:"none", cursor:"pointer",
            background: testSent ? "#22C55E" : PRIMARY,
            color:"#fff", fontFamily:FONT, fontWeight:800, fontSize:14,
            opacity: testing ? 0.7 : 1,
          }}>
            {testSent ? "✓ Notification sent!" : testing ? "Sending…" : "Send Test Notification"}
          </button>
        </div>

        {/* Timezone info */}
        <div style={{ textAlign:"center", marginTop:18, fontFamily:FONT, fontSize:11, color:"rgba(255,255,255,0.3)" }}>
          Times shown in your local timezone · {prefs?.timezone || 'Detecting…'}
        </div>
      </div>
    </div>
  );
}

// ── NOTIFICATIONS PAGE ────────────────────────────────────────────────────────
// Map backend notification types to icon keys for rendering
const NOTIF_ICON_MAP = {
  welcome:          'logo',
  workout_reminder: 'workout',
  ai_summary:       'goal',
  ai_ready:         'goal',
  streak_alert:     'streak',
  streak_broken:    'streak',
  weekly_summary:   'goal',
  meal_reminder:    'meal',
  hydration:        'water',
  payment_failed:   'premium',
  test:             'workout',
};

function NotificationsPage({ onBack, onMarkAllRead }) {
  const { dark } = useTheme();
  const T = dark ? DARK : LIGHT;
  const [showSettings, setShowSettings] = useState(false);
  const [notifications, setNotifications] = useState(null); // null = loading
  const [hasUnread, setHasUnread]         = useState(false);

  useEffect(()=>{
    if (!getAuthToken()) { setNotifications([]); return; }
    apiCall('/notifications')
      .then(d => {
        const list = d?.data?.notifications;
        if (Array.isArray(list)) {
          setNotifications(list);
          setHasUnread(list.some(n => !n.read));
        } else {
          setNotifications([]);
        }
      })
      .catch(() => setNotifications([]));
  }, []);

  const [swipeOffsets, setSwipeOffsets] = useState({});
  const swipeStartRef = useRef({});

  const handleNotifTouchStart = (id, e) => {
    swipeStartRef.current[id] = e.touches[0].clientX;
  };
  const handleNotifTouchMove = (id, e) => {
    const startX = swipeStartRef.current[id];
    if (startX === undefined) return;
    const dx = Math.min(0, e.touches[0].clientX - startX);
    setSwipeOffsets(prev => ({ ...prev, [id]: Math.max(-80, dx) }));
  };
  const handleNotifTouchEnd = (id) => {
    const offset = swipeOffsets[id] || 0;
    if (offset < -60) {
      deleteNotif(id);
    } else {
      setSwipeOffsets(prev => ({ ...prev, [id]: 0 }));
    }
    delete swipeStartRef.current[id];
  };

  const deleteNotif = (id) => {
    setSwipeOffsets(prev => { const n = {...prev}; delete n[id]; return n; });
    setNotifications(p => p.filter(n => n.id !== id));
    if (getAuthToken()) apiCall(`/notifications/${id}`, { method:'DELETE' }).catch(()=>{});
  };

  const markOne = (id) => {
    setNotifications(p => p.map(n => n.id === id ? { ...n, read: true } : n));
    setHasUnread(p => notifications.some(n => n.id !== id && !n.read));
    if (getAuthToken()) apiCall(`/notifications/${id}/read`, { method:'PATCH' }).catch(()=>{});
  };

  const markAll = () => {
    setNotifications(p => p.map(n => ({ ...n, read: true })));
    setHasUnread(false);
    if (getAuthToken()) apiCall('/notifications/read', { method:'PATCH' }).catch(()=>{});
    onMarkAllRead?.();
  };

  // null = loading, [] = loaded-empty, [...] = real data
  const displayList = notifications === null
    ? null
    : notifications.length > 0
      ? notifications.map(n => ({
          id:      n.id,
          title:   n.title,
          body:    n.body,
          time:    new Date(n.createdAt).toLocaleDateString('en-GB', { day:'numeric', month:'short' }),
          iconKey: NOTIF_ICON_MAP[n.type] || 'workout',
          type:    n.type,
          read:    n.read,
        }))
      : [];

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

      {/* Mark all read — always visible, greyed out when nothing to mark */}
      <div style={{ padding:"0 18px 10px", display:"flex", justifyContent:"flex-end", flexShrink:0 }}>
        <button onClick={hasUnread ? markAll : undefined}
          style={{ background:"none", border:"none", fontFamily:FONT, fontWeight:600, fontSize:13,
            color: hasUnread ? PRIMARY : "#444", cursor: hasUnread ? "pointer" : "default",
            opacity: hasUnread ? 1 : 0.4 }}>
          Mark all as read
        </button>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"0 16px 32px" }}>
        {displayList === null && (
          <div style={{ textAlign:"center", padding:"40px 0", fontFamily:FONT, fontSize:13, color:"#555" }}>Loading...</div>
        )}
        {displayList !== null && displayList.length === 0 && (
          <div style={{ textAlign:"center", padding:"60px 20px", fontFamily:FONT, fontSize:14, color:"#555" }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5" style={{display:"block",margin:"0 auto 12px"}}><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
            No notifications yet
          </div>
        )}
        {displayList !== null && displayList.map((n, i) => {
          const isUnread = !n.read;
          const cardBg   = isUnread ? '#00a3ff' : '#fff';
          const titleCol = isUnread ? '#fff'    : '#111';
          const bodyCol  = isUnread ? '#e0f3ff' : '#666';
          const timeCol  = isUnread ? '#b3e0ff' : '#aaa';
          const offset   = swipeOffsets[n.id] || 0;
          const isDragging = swipeStartRef.current[n.id] !== undefined;
          return (
            <div key={n.id} style={{ position:"relative", marginBottom:12, borderRadius:18, overflow:"hidden", animation:`fadeUp 0.3s ease ${i*0.05}s both` }}>
              {/* Delete button revealed on swipe */}
              <div style={{ position:"absolute", right:0, top:0, bottom:0, width:76, background:"#EF4444", display:"flex", alignItems:"center", justifyContent:"center", borderRadius:"0 18px 18px 0" }}
                onClick={() => deleteNotif(n.id)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
              </div>
              {/* Main card — slides left on swipe */}
              <div
                onTouchStart={(e) => handleNotifTouchStart(n.id, e)}
                onTouchMove={(e) => handleNotifTouchMove(n.id, e)}
                onTouchEnd={() => handleNotifTouchEnd(n.id)}
                onClick={() => { if (offset === 0 && displayList) markOne(n.id); }}
                style={{ background: cardBg, borderRadius:18, padding:"16px 18px", display:"flex", gap:14, alignItems:"flex-start", cursor:"pointer", transition: isDragging ? "none" : "transform 0.3s ease, background 0.3s", transform:`translateX(${offset}px)` }}>
                {/* Icon */}
                <div style={{ width:44, height:44, borderRadius:"50%", background:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, overflow:"hidden" }}>
                  {n.iconKey==="logo"      && <VTRXLogo size={18}/>}
                  {n.iconKey==="workout"   && <svg width="20" height="20" viewBox="0 0 24 24" fill="#60A5FA" stroke="none"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>}
                  {n.iconKey==="goal"      && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>}
                  {n.iconKey==="meal"      && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" strokeWidth="2"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>}
                  {n.iconKey==="streak"    && <svg width="20" height="20" viewBox="0 0 24 24" fill="#F87171"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>}
                  {n.iconKey==="challenge" && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>}
                  {n.iconKey==="premium"   && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FCD34D" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01z"/></svg>}
                  {n.iconKey==="nutrition" && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>}
                  {n.iconKey==="steps"     && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22D3EE" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
                  {n.iconKey==="sleep"     && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818CF8" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>}
                  {n.iconKey==="water"     && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38BDF8" strokeWidth="2"><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></svg>}
                  {n.iconKey==="rest"      && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F472B6" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>}
                  {(!n.iconKey || (n.iconKey !== 'logo' && !['workout','goal','meal','streak','challenge','premium','nutrition','steps','sleep','water','rest'].includes(n.iconKey))) && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>}
                </div>
                {/* Body */}
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                    <div style={{ fontFamily:FONT, fontWeight:800, fontSize:15, color:titleCol }}>{n.title}</div>
                    <div style={{ fontFamily:FONT, fontSize:12, color:timeCol, marginLeft:8, whiteSpace:"nowrap", flexShrink:0 }}>{n.time}</div>
                  </div>
                  <div style={{ fontFamily:FONT, fontSize:13, color:bodyCol, lineHeight:1.55 }}>{n.body}</div>
                </div>
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

// ─── Measurement helpers ──────────────────────────────────────────────────────
function calcAgeFromDob(dob) {
  if (!dob || typeof dob !== "string") return null;
  const parts = dob.split("/");
  let d;
  if (parts.length === 3 && parts[2]?.length === 4) {
    d = new Date(`${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`);
  } else { d = new Date(dob); }
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age >= 1 ? age : null;
}
function kgToDisplay(kg, unit) {
  const v = parseFloat(kg); if (!v) return "";
  return unit === "lbs" ? (v * 2.20462).toFixed(1) : String(v);
}
function cmToDisplay(cm, unit) {
  const v = parseFloat(cm); if (!v) return "";
  if (unit === "ft") {
    const totalIn = v / 2.54;
    const ft = Math.floor(totalIn / 12);
    const ins = Math.round(totalIn % 12);
    return `${ft}'${ins}`;
  }
  return String(Math.round(v));
}
function toKg(val, unit) {
  const v = parseFloat(val);
  if (isNaN(v) || v <= 0) return null;
  return unit === "lbs" ? parseFloat((v * 0.453592).toFixed(1)) : v;
}
function toCm(val, unit) {
  if (unit === "ft") {
    const m = String(val).match(/(\d+)[^\d]*(\d*)/);
    if (!m) return null;
    const cm = Math.round((parseInt(m[1]) || 0) * 30.48 + (parseInt(m[2] || 0) || 0) * 2.54);
    return cm > 0 ? cm : null;
  }
  const v = parseFloat(val);
  return isNaN(v) || v <= 0 ? null : Math.round(v);
}
function getUnitPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function PersonalDetailsPage({ onBack }) {
  const { user, setUser } = useUser();
  const initWU = getUnitPref("vtrx_weight_unit", "kg");
  // If stored height is already a ft display string (e.g. "5'7"), keep ft mode
  const storedHtIsFt = typeof user.height === "string" && user.height.includes("'");
  const initHU = storedHtIsFt ? "ft" : getUnitPref("vtrx_height_unit", "cm");
  const [name,       setName]       = useState(user.name || "");
  const [dob,        setDob]        = useState(() => { try { return localStorage.getItem("vtrx_user_dob") || ""; } catch { return ""; } });
  const [gender,     setGender]     = useState(user.gender || "");
  const [weightUnit, setWeightUnit] = useState(initWU);
  const [heightUnit, setHeightUnit] = useState(initHU);
  const [weight,     setWeight]     = useState(() => kgToDisplay(user.weight, initWU));
  const [height,     setHeight]     = useState(() => {
    if (storedHtIsFt) return String(user.height);
    const n = parseFloat(user.height);
    return (isNaN(n) || n < 50) ? "" : cmToDisplay(n, initHU);
  });
  const [saved,      setSaved]      = useState(false);

  // Weight unit conversion
  const switchWeightUnit = (u) => {
    const v = parseFloat(weight);
    if (!isNaN(v)) {
      if (u === "kg"  && weightUnit === "lbs") setWeight((v * 0.453592).toFixed(1));
      if (u === "lbs" && weightUnit === "kg")  setWeight((v * 2.20462).toFixed(1));
    }
    setWeightUnit(u);
  };

  // Height unit conversion
  const switchHeightUnit = (u) => {
    if (u === "cm" && heightUnit === "ft") {
      const parts = height.split("'");
      const ft = parseFloat(parts[0]) || 0;
      const ins = parseFloat(parts[1]) || 0;
      setHeight(Math.round((ft * 30.48) + (ins * 2.54)).toString());
    } else if (u === "ft" && heightUnit === "cm") {
      const cm = parseFloat(height) || 0;
      const totalIn = cm / 2.54;
      const ft = Math.floor(totalIn / 12);
      const ins = Math.round(totalIn % 12);
      setHeight(ft + "'" + ins);
    }
    setHeightUnit(u);
  };

  // Auto-format height in ft (insert apostrophe after feet digit)
  const handleHeightChange = (val) => {
    if (heightUnit === "ft") {
      const digits = val.replace(/[^0-9]/g, "");
      if (digits.length === 0) { setHeight(""); return; }
      if (digits.length === 1) { setHeight(digits); return; }
      const ft = digits[0];
      const ins = digits.slice(1, 3);
      setHeight(ft + "'" + ins);
    } else {
      setHeight(val.replace(/[^0-9.]/g, ""));
    }
  };

  const save = async () => {
    const ageVal   = calcAgeFromDob(dob);
    const weightKg = toKg(weight, weightUnit);
    const heightCm = toCm(height, heightUnit);
    try {
      localStorage.setItem("vtrx_weight_unit", weightUnit);
      localStorage.setItem("vtrx_height_unit", heightUnit);
      if (dob) localStorage.setItem("vtrx_user_dob", dob);
    } catch {}
    setUser(u=>({...u, name, dob, age: ageVal, gender, weight: weightKg, height: heightCm}));
    setSaved(true);
    setTimeout(()=>setSaved(false), 2200);
    if (!DEMO_MODE && getAuthToken()) {
      apiCall("/users/profile", { method:"PUT", body:JSON.stringify({ name, age: ageVal, gender, weight: weightKg, height: heightCm }) }).catch(_e=>{});
    }
  };

  const UnitToggle = ({ units, current, onChange }) => (
    <div style={{ display:"flex",background:"#1a1a1a",borderRadius:20,padding:3,marginBottom:10 }}>
      {units.map(u=>(
        <button key={u} onClick={()=>onChange(u)}
          style={{ flex:1,padding:"5px 12px",borderRadius:16,border:"none",
                   background:current===u?PRIMARY:"transparent",
                   fontFamily:FONT,fontWeight:600,fontSize:11,
                   color:current===u?"#fff":"#555",cursor:"pointer",transition:"all 0.2s" }}>{u}</button>
      ))}
    </div>
  );

  return (
    <SubShell title="PERSONAL DETAILS" onBack={onBack}>
      {/* Name, DOB, Gender */}
      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"20px",marginBottom:14 }}>
        <DarkInput label="FULL NAME" value={name} onChange={setName}/>
        <div style={{ marginBottom:16 }}>
          <div style={{ fontFamily:FONT,fontWeight:600,fontSize:12,color:"#888888",letterSpacing:0.5,marginBottom:7 }}>DATE OF BIRTH</div>
          <input value={dob} placeholder="DD/MM/YYYY" inputMode="numeric"
            onChange={e=>{
              let v = e.target.value.replace(/[^0-9]/g,"");
              if (v.length > 2) v = v.slice(0,2)+"/"+v.slice(2);
              if (v.length > 5) v = v.slice(0,5)+"/"+v.slice(5);
              if (v.length > 10) v = v.slice(0,10);
              setDob(v);
            }}
            style={{ width:"100%",background:CARD2,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",fontFamily:FONT,fontSize:14,fontWeight:500,color:"#ffffff",outline:"none",boxSizing:"border-box",transition:"border-color 0.2s" }}/>
          {dob && calcAgeFromDob(dob) != null && (
            <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:6 }}>
              Age: {calcAgeFromDob(dob)} years
            </div>
          )}
        </div>
        <div style={{ marginBottom:16 }}>
          <div style={{ fontFamily:FONT,fontWeight:600,fontSize:12,color:"#888888",letterSpacing:0.5,marginBottom:8 }}>GENDER</div>
          <div style={{ display:"flex",gap:8 }}>
            {["Male","Female","Other","N/A"].map(g=>(
              <button key={g} onClick={()=>setGender(g)}
                style={{ flex:1,padding:"11px 0",borderRadius:12,border:`1.5px solid ${gender===g?PRIMARY:BORDER}`,
                         background:gender===g?`${PRIMARY}18`:"transparent",fontFamily:FONT,fontWeight:600,
                         fontSize:12,color:gender===g?PRIMARY:"#555",cursor:"pointer",transition:"all 0.2s" }}>{g}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Body Stats */}
      <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"20px",marginBottom:14 }}>
        <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888888",letterSpacing:0.5,marginBottom:14 }}>BODY STATS</div>

        {/* Weight */}
        <div style={{ marginBottom:14 }}>
          <div style={{ fontFamily:FONT,fontWeight:600,fontSize:11,color:"#888888",marginBottom:6 }}>WEIGHT</div>
          <UnitToggle units={["lbs","kg"]} current={weightUnit} onChange={switchWeightUnit}/>
          <div style={{ background:"#1e1e1e",border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:8 }}>
            <DetailFieldIcon type="scale"/>
            <input value={weight} onChange={e=>setWeight(e.target.value.replace(/[^0-9.]/g,""))}
              inputMode="decimal" placeholder={weightUnit==="lbs"?"160":"73"}
              style={{ flex:1,background:"none",border:"none",fontFamily:FONT,fontSize:16,fontWeight:700,color:"#fff",outline:"none",width:"100%" }}/>
            <span style={{ fontFamily:FONT,fontSize:13,color:"#555" }}>{weightUnit}</span>
          </div>
        </div>

        {/* Height */}
        <div>
          <div style={{ fontFamily:FONT,fontWeight:600,fontSize:11,color:"#888888",marginBottom:6 }}>
            HEIGHT{heightUnit==="ft" ? " — feet then inches (e.g. 5'9)" : ""}
          </div>
          <UnitToggle units={["ft","cm"]} current={heightUnit} onChange={switchHeightUnit}/>
          <div style={{ background:"#1e1e1e",border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:8 }}>
            <DetailFieldIcon type="ruler"/>
            <input value={height} onChange={e=>handleHeightChange(e.target.value)}
              inputMode="numeric" placeholder={heightUnit==="ft"?"5'9":"178"}
              style={{ flex:1,background:"none",border:"none",fontFamily:FONT,fontSize:16,fontWeight:700,color:"#fff",outline:"none",width:"100%" }}/>
            <span style={{ fontFamily:FONT,fontSize:13,color:"#555" }}>{heightUnit}</span>
          </div>
        </div>
      </div>

      <SaveBtn onClick={save} saved={saved}/>
    </SubShell>
  );
}


function GoalIcon({ type }) {
  const s = { width:22, height:22, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:"2" };
  if (type==="fire")    return <svg {...s}><path d="M12 2c0 6-6 8-6 14a6 6 0 0012 0c0-6-6-8-6-14z"/></svg>;
  if (type==="muscle")  return <svg {...s}><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>;
  if (type==="bolt")    return <svg {...s}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
  if (type==="run")     return <svg {...s}><circle cx="12" cy="5" r="2"/><path d="M10 22v-6l-2-3 4-4 2 3h4"/><path d="M10 13l-4 2"/></svg>;
  if (type==="star")    return <svg {...s}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
  if (type==="sparkle") return <svg {...s}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/></svg>;
  return <svg {...s}><circle cx="12" cy="12" r="10"/></svg>;
}
function FitnessGoalPage({ onBack }) {
  const { user, setUser } = useUser();
  const [goal, setGoal]   = useState(user.goal);
  const [level, setLevel] = useState(user.fitnessLevel || user.level || "");
  const [days, setDays]   = useState(Number(user.daysPerWeek || user.days) || 5);
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

      <SaveBtn onClick={async ()=>{
      setUser(u=>({...u,goal,level,days,fitnessLevel:level,daysPerWeek:parseInt(days)||5}));
      setSaved(true);
      setTimeout(()=>setSaved(false),2200);
      if (!DEMO_MODE && getAuthToken()) {
        apiCall('/users/profile',{ method:'PUT', body:JSON.stringify({ goal, fitnessLevel:level, daysPerWeek:parseInt(days)||5 }) }).catch(()=>{});
      }
    }} saved={saved}/>
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
  const [saved,   setSaved]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error,   setError]     = useState("");
  const strong = newPass.length >= 8;
  const match  = newPass && newPass===confirm;

  const strength = newPass.length === 0 ? 0 : newPass.length < 6 ? 1 : newPass.length < 10 ? 2 : 3;
  const strengthColors = ["#EF4444","#F97316","#EAB308","#22C55E"];
  const strengthLabels = ["","Weak","Fair","Strong"];

  const handleSave = async () => {
    if (!match || !strong || !current) return;
    setLoading(true);
    setError("");
    try {
      await apiCall("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: newPass }),
      });
      setSaved(true);
      setCurrent(""); setNewPass(""); setConfirm("");
      setTimeout(() => setSaved(false), 2200);
    } catch (e) {
      setError(e.message || "Failed to update password. Check your current password.");
    } finally {
      setLoading(false);
    }
  };

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
        {error&&<div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginTop:8,textAlign:"center",padding:"10px",background:"rgba(239,68,68,0.08)",borderRadius:10 }}>{error}</div>}
      </div>
      <SaveBtn onClick={handleSave} saved={saved} label={loading?"UPDATING...":"UPDATE PASSWORD"}/>
    </SubShell>
  );
}

// ─ Payment Method ─────────────────────────────────────────────────────────────
function PaymentMethodPage({ onBack }) {
  const [methods,       setMethods]       = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [err,           setErr]           = useState("");

  useEffect(()=>{
    apiCall("/payments/methods")
      .then(res => setMethods(res?.data?.methods || []))
      .catch(()=>{})
      .finally(()=>setLoading(false));
  }, []);

  const openPortal = async () => {
    setPortalLoading(true); setErr("");
    try {
      const data = await apiCall("/payments/portal", { method:"POST" });
      if (data.data?.url) window.location.href = data.data.url;
    } catch(e) {
      setErr(e.message || "Could not open billing portal.");
      setPortalLoading(false);
    }
  };

  const brandColor = b => ({ visa:"#1A1FD6", mastercard:"#EB001B", amex:"#2E77BC", discover:"#FF6600" })[b?.toLowerCase()] || "#555";

  return (
    <SubShell title="PAYMENT METHOD" onBack={onBack}>
      {loading ? (
        <div style={{ textAlign:"center",padding:"40px 0",color:"#555",fontFamily:FONT,fontSize:14 }}>Loading...</div>
      ) : methods.length > 0 ? (
        <>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#888",letterSpacing:1,marginBottom:12 }}>SAVED CARDS</div>
          <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
            {methods.map(m=>(
              <div key={m.id} style={{ display:"flex",alignItems:"center",gap:14,padding:"16px 18px",borderRadius:18,border:`1.5px solid ${m.isDefault?PRIMARY:BORDER}`,background:m.isDefault?`${PRIMARY}12`:CARD }}>
                <div style={{ width:44,height:30,borderRadius:8,background:brandColor(m.brand),display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                  <span style={{ fontFamily:FONT,fontWeight:900,fontSize:10,color:"#fff",letterSpacing:1 }}>{m.brand.toUpperCase()}</span>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff" }}>{m.brand.charAt(0).toUpperCase()+m.brand.slice(1)} ending in {m.last4}</div>
                  <div style={{ fontFamily:FONT,fontSize:12,color:"#888",marginTop:2 }}>Expires {String(m.expMonth).padStart(2,"0")}/{String(m.expYear).slice(-2)}</div>
                </div>
                {m.isDefault&&<div style={{ fontFamily:FONT,fontSize:10,fontWeight:700,color:PRIMARY,background:`${PRIMARY}22`,borderRadius:20,padding:"3px 8px" }}>DEFAULT</div>}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ textAlign:"center",padding:"32px 20px 24px" }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5" style={{display:"block",margin:"0 auto 14px"}}><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",marginBottom:6 }}>No payment methods</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#888",marginBottom:24 }}>Add a card to manage your subscription.</div>
        </div>
      )}
      {err&&<div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{err}</div>}
      <button onClick={openPortal} disabled={portalLoading}
        style={{ width:"100%",padding:"14px 0",borderRadius:50,background:"transparent",border:`1.5px dashed ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888",cursor:portalLoading?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:10,opacity:portalLoading?0.6:1 }}>
        <span style={{ fontSize:18 }}>+</span> {portalLoading?"Opening Stripe...":"Add / Manage Payment Methods"}
      </button>
      <div style={{ fontFamily:FONT,fontSize:11,color:"#444",textAlign:"center" }}>Securely managed by Stripe</div>
    </SubShell>
  );
}

// ─ Billing History ────────────────────────────────────────────────────────────
function BillingHistoryPage({ onBack }) {
  const [invoices, setInvoices] = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(()=>{
    apiCall("/payments/invoices")
      .then(res=>setInvoices(res?.data?.invoices || []))
      .catch(()=>{})
      .finally(()=>setLoading(false));
  }, []);

  const statusColor = s => s==="Paid"?"#22C55E":s==="Due"?"#F59E0B":"#EF4444";

  return (
    <SubShell title="BILLING HISTORY" onBack={onBack}>
      {loading ? (
        <div style={{ textAlign:"center",padding:"40px 0",color:"#555",fontFamily:FONT,fontSize:14 }}>Loading...</div>
      ) : invoices.length === 0 ? (
        <div style={{ textAlign:"center",padding:"40px 20px" }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5" style={{display:"block",margin:"0 auto 14px"}}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:15,color:"#fff",marginBottom:6 }}>No billing history</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#888" }}>Your invoices will appear here after your first payment.</div>
        </div>
      ) : (
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"0 18px",overflow:"hidden" }}>
          {invoices.map((b,i)=>(
            <div key={b.id||i} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 0",borderBottom:i<invoices.length-1?`1px solid ${BORDER}`:"none" }}>
              <div>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",marginBottom:3 }}>{b.desc}</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#888" }}>{b.date}{b.last4?` · ••••${b.last4}`:""}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",marginBottom:4 }}>{b.amount}</div>
                <div style={{ background:`${statusColor(b.status)}18`,border:`1px solid ${statusColor(b.status)}44`,borderRadius:20,padding:"2px 10px",display:"inline-block" }}>
                  <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:statusColor(b.status),letterSpacing:0.5 }}>{b.status}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SubShell>
  );
}

// ─ Upgrade Plan ───────────────────────────────────────────────────────────────
function UpgradePlanPage({ onBack }) {
  const [selected, setSelected] = useState("annual");

  const plans = [
    { key:"monthly", label:"Monthly", price:"$9.99",  period:"/month", savings:null,        badge:null         },
    { key:"annual",  label:"Annual",  price:"$69.99", period:"/year",  savings:"Save 41%",  badge:"BEST VALUE" },
  ];

  const features = ["Unlimited workout videos","AI-powered summaries","Money-backed challenges","Advanced analytics","Priority support","Custom workout builder"];

  const handleUpgrade = () => {
    openPaymentSheet(selected);
  };

  return (
    <SubShell title="UPGRADE PLAN" onBack={onBack}>
      <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:20 }}>
        {plans.map(p=>(
          <button key={p.key} onClick={()=>setSelected(p.key)} style={{ display:"flex",alignItems:"center",padding:"16px 18px",borderRadius:18,border:`2px solid ${selected===p.key?PRIMARY:BORDER}`,background:selected===p.key?`${PRIMARY}12`:CARD,cursor:"pointer",textAlign:"left",gap:14,transition:"all 0.2s",position:"relative",overflow:"hidden" }}>
            {p.badge&&<div style={{ position:"absolute",top:0,right:0,background:PRIMARY,padding:"4px 12px",borderRadius:"0 16px 0 12px",fontFamily:FONT,fontWeight:800,fontSize:10,color:"#fff",letterSpacing:1 }}>{p.badge}</div>}
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:selected===p.key?PRIMARY:"#fff",marginBottom:2 }}>{p.label}</div>
              {p.savings&&<div style={{ fontFamily:FONT,fontSize:12,color:"#22C55E" }}>{p.savings}</div>}
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:selected===p.key?PRIMARY:"#fff" }}>{p.price}</div>
              <div style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>{p.period}</div>
            </div>
          </button>
        ))}
      </div>

      <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:20 }}>
        <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#888",letterSpacing:1,marginBottom:14 }}>ALL PLANS INCLUDE</div>
        {features.map((f,i)=>(
          <div key={i} style={{ display:"flex",alignItems:"center",gap:12,marginBottom:i<features.length-1?12:0 }}>
            <div style={{ width:20,height:20,borderRadius:"50%",background:`${PRIMARY}20`,border:`1px solid ${PRIMARY}55`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke={PRIMARY} strokeWidth="2"><polyline points="1,4 3.5,7 9,1"/></svg>
            </div>
            <span style={{ fontFamily:FONT,fontSize:14,color:"#ccc" }}>{f}</span>
          </div>
        ))}
      </div>

      <button onClick={handleUpgrade}
        style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1,cursor:"pointer",boxShadow:`0 4px 24px ${PRIMARY}55` }}>
        UPGRADE NOW →
      </button>
      <div style={{ fontFamily:FONT,fontSize:11,color:"#444",textAlign:"center",marginTop:10 }}>Secure checkout powered by Stripe · Cancel anytime</div>
    </SubShell>
  );
}

// ─ Cancel Subscription ────────────────────────────────────────────────────────
function CancelSubscriptionPage({ onBack }) {
  const [step, setStep]       = useState(0); // 0=confirm 1=reason 2=redirecting
  const [reason, setReason]   = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");
  const reasons = ["Too expensive","Not using it enough","Missing features I need","Found a better app","Technical issues","Other"];

  const openPortal = async () => {
    setLoading(true); setErr("");
    try {
      const data = await apiCall("/payments/portal", { method:"POST" });
      if (data.data?.url) {
        window.location.href = data.data.url;
      }
    } catch(e) {
      setErr(e.message || "Could not open billing portal. Please try again.");
      setLoading(false);
    }
  };

  return (
    <SubShell title="CANCEL SUBSCRIPTION" onBack={onBack}>
      {step === 0 && (
        <div style={{ animation:"fadeUp 0.3s ease both" }}>
          <div style={{ background:"#1c0c0c",border:"1px solid #EF444433",borderRadius:20,padding:"24px 20px",textAlign:"center",marginBottom:20 }}>
            <div style={{ width:64,height:64,borderRadius:"50%",background:"#EF444422",border:"1px solid #EF444455",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px" }}><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:18,color:"#fff",marginBottom:8 }}>We're sorry to see you go</div>
            <div style={{ fontFamily:FONT,fontSize:14,color:"#888888",lineHeight:1.65 }}>Cancelling will end your Premium access at the end of your current billing period. You'll lose access to AI summaries, unlimited videos, and challenges.</div>
          </div>
          <div style={{ background:"rgba(255,255,255,0.05)",borderRadius:20,border:`1px solid ${BORDER}`,padding:"18px",marginBottom:16 }}>
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
          {err && <div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{err}</div>}
          <button onClick={()=>reason&&openPortal()} disabled={loading||!reason}
            style={{ width:"100%",padding:"15px 0",borderRadius:50,background:reason&&!loading?"#EF4444":"#1a1a1a",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:reason&&!loading?"#fff":"#333",letterSpacing:1,cursor:reason&&!loading?"pointer":"not-allowed" }}>
            {loading ? "OPENING BILLING PORTAL..." : "CONFIRM CANCELLATION"}
          </button>
        </div>
      )}
    </SubShell>
  );
}

// ── Stripe Elements appearance — matches dark app theme ──────────────────────
const STRIPE_APPEARANCE = {
  theme: "night",
  variables: {
    colorPrimary:           "#00A3FF",
    colorBackground:        "#111111",
    colorText:              "#ffffff",
    colorTextSecondary:     "#888888",
    colorTextPlaceholder:   "#444444",
    colorDanger:            "#EF4444",
    fontFamily:             "'Montserrat', system-ui, sans-serif",
    fontSizeBase:           "15px",
    spacingUnit:            "4px",
    borderRadius:           "12px",
  },
  rules: {
    ".Input": {
      border:     "1px solid rgba(255,255,255,0.1)",
      boxShadow:  "none",
      background: "#1a1a1a",
      color:      "#ffffff",
      padding:    "14px 16px",
    },
    ".Input:focus": {
      border:    "1px solid #00A3FF",
      boxShadow: "0 0 0 3px rgba(0,163,255,0.15)",
    },
    ".Input--invalid": { border: "1px solid #EF4444" },
    ".Label": {
      fontWeight:    "700",
      letterSpacing: "0.08em",
      fontSize:      "11px",
      color:         "#888888",
    },
    ".Tab": { border: "1px solid rgba(255,255,255,0.08)", background: "#1a1a1a" },
    ".Tab--selected": { border: "1px solid #00A3FF", background: "rgba(0,163,255,0.08)" },
    ".TabLabel--selected": { color: "#00A3FF" },
    ".Block": { background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px" },
    ".CheckboxInput": { background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.12)" },
  },
};

// ── In-app payment bottom sheet ───────────────────────────────────────────────
function PaymentSheet({ initialPlan = "monthly", onClose }) {
  const [plan,         setPlan]         = useState(initialPlan);
  const [clientSecret, setClientSecret] = useState(null);
  const [isTrial,      setIsTrial]      = useState(false);
  const [fetching,     setFetching]     = useState(false);
  const [err,          setErr]          = useState("");

  const PLANS = {
    monthly: { label:"Monthly",  price:"$9.99",  period:"/month", sub:"Billed monthly" },
    annual:  { label:"Annual",   price:"$69.99", period:"/year",  sub:"Save 41% · $5.83/mo", badge:"BEST VALUE" },
  };

  const trialEnd = new Date(Date.now() + 30 * 864e5).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });

  const fetchIntent = async (p) => {
    setFetching(true); setErr(""); setClientSecret(null);
    try {
      const res = await apiCall("/payments/create-subscription-intent", {
        method: "POST",
        body:   JSON.stringify({ plan: p }),
      });
      setClientSecret(res.data.clientSecret);
      setIsTrial(res.data.isTrial || false);
    } catch(e) {
      const raw = e.message || "";
      const isStripeConfig = raw.includes("No such price") || raw.includes("not yet configured") || raw.includes("paste_your");
      setErr(isStripeConfig
        ? "Payments are not yet active. Please contact support."
        : (raw || "Couldn't load payment form. Try again.")
      );
    } finally {
      setFetching(false);
    }
  };

  return (
    <div style={{ position:"fixed",inset:0,zIndex:400,display:"flex",flexDirection:"column",justifyContent:"flex-end" }}>
      <div onClick={onClose} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.88)" }}/>
      <div style={{ position:"relative",background:"#0f0f0f",borderRadius:"26px 26px 0 0",maxHeight:"94vh",display:"flex",flexDirection:"column",animation:"slideUp 0.32s cubic-bezier(0.32,0.72,0,1) both" }}>
        {/* Drag handle */}
        <div style={{ flexShrink:0,display:"flex",justifyContent:"center",padding:"12px 0 6px" }}>
          <div style={{ width:38,height:4,borderRadius:2,background:"rgba(255,255,255,0.15)" }}/>
        </div>
        {/* Header */}
        <div style={{ flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 22px 0" }}>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:19,color:"#fff" }}>
            {clientSecret?"Secure Checkout":"Upgrade to Premium"}
          </div>
          <button onClick={onClose} style={{ width:30,height:30,borderRadius:"50%",background:"rgba(255,255,255,0.08)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div style={{ flex:1,overflowY:"auto",padding:"18px 22px 44px" }}>
          {!clientSecret ? (
            <>
              {/* Plan selector */}
              <div style={{ display:"flex",gap:10,marginBottom:18 }}>
                {Object.entries(PLANS).map(([key,p])=>(
                  <button key={key} onClick={()=>{ setPlan(key); setErr(""); }}
                    style={{ flex:1,padding:"16px 10px",borderRadius:18,border:`2px solid ${plan===key?PRIMARY:BORDER}`,background:plan===key?`${PRIMARY}14`:"#111",cursor:"pointer",textAlign:"center",position:"relative",transition:"all 0.18s",overflow:"hidden" }}>
                    {p.badge&&<div style={{ position:"absolute",top:0,right:0,background:PRIMARY,padding:"3px 10px",borderRadius:"0 16px 0 12px",fontFamily:FONT,fontWeight:800,fontSize:9,color:"#fff",letterSpacing:0.8 }}>{p.badge}</div>}
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:22,color:plan===key?PRIMARY:"#fff",marginBottom:2 }}>{p.price}</div>
                    <div style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>{p.period}</div>
                    <div style={{ fontFamily:FONT,fontSize:10,color:plan===key?"#00A3FF88":"#444",marginTop:3,lineHeight:1.3 }}>{p.sub}</div>
                  </button>
                ))}
              </div>

              {/* Trial notice */}
              <div style={{ background:"rgba(0,163,255,0.07)",border:"1px solid rgba(0,163,255,0.2)",borderRadius:14,padding:"12px 16px",marginBottom:20,display:"flex",gap:12,alignItems:"flex-start" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00A3FF" strokeWidth="2" style={{flexShrink:0,marginTop:1}}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#aaa",lineHeight:1.55 }}>
                  <span style={{ color:"#fff",fontWeight:700 }}>30-day free trial.</span> Your card is saved securely today but not charged until <span style={{ color:"#fff" }}>{trialEnd}</span>. Cancel anytime.
                </div>
              </div>

              {/* Feature bullets */}
              <div style={{ marginBottom:22 }}>
                {["Unlimited workout videos & AI coaching","Full analytics, history & weekly AI report","Complete meal plans & grocery list","Apple Pay, Google Pay — saved for renewals","Cancel anytime from Account Settings"].map((f,i)=>(
                  <div key={i} style={{ display:"flex",alignItems:"center",gap:12,marginBottom:i<4?10:0 }}>
                    <div style={{ width:20,height:20,borderRadius:"50%",background:"rgba(0,163,255,0.1)",border:"1px solid rgba(0,163,255,0.3)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke={PRIMARY} strokeWidth="2.5"><polyline points="1,4 3.5,7 9,1"/></svg>
                    </div>
                    <span style={{ fontFamily:FONT,fontSize:13,color:"#bbb" }}>{f}</span>
                  </div>
                ))}
              </div>

              {err&&<div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{err}</div>}
              <button onClick={()=>fetchIntent(plan)} disabled={fetching}
                style={{ width:"100%",padding:"17px 0",borderRadius:50,background:fetching?"#1a1a1a":`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:fetching?`1px solid ${BORDER}`:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:fetching?"#555":"#fff",cursor:fetching?"not-allowed":"pointer",letterSpacing:0.5,transition:"all 0.2s" }}>
                {fetching?"Loading secure form...":"Continue to Payment"}
              </button>
              <div style={{ fontFamily:FONT,fontSize:11,color:"#444",textAlign:"center",marginTop:10 }}>
                🔒 Secured by Stripe · 256-bit SSL encryption
              </div>
            </>
          ) : _stripePromise ? (
            <Elements
              stripe={_stripePromise}
              options={{
                clientSecret,
                appearance: STRIPE_APPEARANCE,
                fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&display=swap" }],
              }}
            >
              <CheckoutForm
                plan={plan}
                isTrial={isTrial}
                clientSecret={clientSecret}
                onSuccess={onClose}
                onBack={()=>setClientSecret(null)}
              />
            </Elements>
          ) : (
            <div style={{ textAlign:"center",padding:"40px 0",fontFamily:FONT,fontSize:13,color:"#EF4444",lineHeight:1.6 }}>
              Stripe is not configured.<br/>Add VITE_STRIPE_PUBLISHABLE_KEY to your Vercel environment variables.
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
    </div>
  );
}

function CheckoutForm({ plan, isTrial, clientSecret, onSuccess, onBack }) {
  const stripe    = useStripe();
  const elements  = useElements();
  const { setIsPremium } = useUser();
  const [loading,   setLoading]   = useState(false);
  const [err,       setErr]       = useState("");
  const [done,      setDone]      = useState(false);
  const [payReq,    setPayReq]    = useState(null);
  const [prChecked, setPrChecked] = useState(false);

  const PLAN_LABEL  = { monthly:"$9.99 / month", annual:"$69.99 / year" };
  const PLAN_AMOUNT = { monthly: 999, annual: 6999 };

  // Build a PaymentRequest so we can show native Apple Pay / Google Pay buttons
  useEffect(() => {
    if (!stripe || !clientSecret) return;
    const pr = stripe.paymentRequest({
      country:  "US",
      currency: "usd",
      total: {
        label:  isTrial ? "VTRX Premium (30-day free trial)" : `VTRX Premium ${plan === "annual" ? "Annual" : "Monthly"}`,
        amount: isTrial ? 0 : (PLAN_AMOUNT[plan] || 999),
      },
      requestPayerName:  false,
      requestPayerEmail: false,
    });

    pr.canMakePayment().then(result => {
      if (result) setPayReq(pr);
      setPrChecked(true);
    });

    pr.on("paymentmethod", async (ev) => {
      setLoading(true); setErr("");
      const confirmFn = isTrial ? stripe.confirmSetup : stripe.confirmPayment;
      const { error } = await confirmFn({
        clientSecret,
        confirmParams: { payment_method: ev.paymentMethod.id },
        redirect: "if_required",
      });
      if (error) {
        ev.complete("fail");
        setErr(error.message || "Payment failed.");
        setLoading(false);
      } else {
        ev.complete("success");
        track("subscription_started", { plan, method: "wallet", isTrial });
        setIsPremium(true);
        setDone(true);
        setTimeout(onSuccess, 2600);
      }
    });
  }, [stripe, clientSecret, plan, isTrial]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setLoading(true); setErr("");
    const confirmFn = isTrial
      ? (opts) => stripe.confirmSetup(opts)
      : (opts) => stripe.confirmPayment(opts);
    const { error } = await confirmFn({
      elements,
      confirmParams: { return_url: window.location.origin },
      redirect: "if_required",
    });
    if (error) {
      setErr(error.message || "Payment failed. Please check your card details.");
      setLoading(false);
      return;
    }
    track("subscription_started", { plan, method: "card", isTrial });
    setIsPremium(true);
    setDone(true);
    setTimeout(onSuccess, 2600);
  };

  if (done) return (
    <div style={{ textAlign:"center",padding:"48px 0 24px" }}>
      <div style={{ width:76,height:76,borderRadius:"50%",background:"rgba(34,197,94,0.1)",border:"2px solid rgba(34,197,94,0.4)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",animation:"fadeUp 0.4s ease both" }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div style={{ fontFamily:FONT,fontWeight:900,fontSize:23,color:"#fff",marginBottom:10 }}>Welcome to Premium!</div>
      <div style={{ fontFamily:FONT,fontSize:14,color:"#888",lineHeight:1.65,maxWidth:260,margin:"0 auto" }}>
        {isTrial
          ? "Your 30-day free trial is now active. You won't be charged until the trial ends."
          : "Your subscription is active. Enjoy full access to all features."}
      </div>
    </div>
  );

  return (
    <form onSubmit={handleSubmit}>
      {/* Back + plan summary */}
      <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:18 }}>
        <button type="button" onClick={onBack}
          style={{ width:30,height:30,borderRadius:"50%",background:"rgba(255,255,255,0.06)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex:1,fontFamily:FONT,fontSize:13,color:"#888" }}>
          {isTrial&&<span style={{ color:"#22C55E",fontWeight:700 }}>Free trial · </span>}
          then <span style={{ color:"#fff",fontWeight:700 }}>{PLAN_LABEL[plan]}</span>
        </div>
      </div>

      {/* Apple Pay / Google Pay — shown as a prominent button when the browser supports it */}
      {prChecked && payReq && (
        <>
          <PaymentRequestButtonElement
            options={{
              paymentRequest: payReq,
              style: { paymentRequestButton: { type:"default", theme:"dark", height:"50px" } },
            }}
          />
          <div style={{ display:"flex",alignItems:"center",gap:10,margin:"16px 0 14px" }}>
            <div style={{ flex:1,height:1,background:"rgba(255,255,255,0.1)" }}/>
            <span style={{ fontFamily:FONT,fontSize:11,color:"#555",letterSpacing:0.4 }}>or pay with card</span>
            <div style={{ flex:1,height:1,background:"rgba(255,255,255,0.1)" }}/>
          </div>
        </>
      )}

      {/* Card form — wallets hidden when the PaymentRequestButton is already showing them */}
      {prChecked && (
        <PaymentElement
          options={{
            layout:  { type:"tabs", defaultCollapsed:false },
            wallets: payReq
              ? { applePay:"never", googlePay:"never" }
              : { applePay:"auto",  googlePay:"auto"  },
            fields:  { billingDetails:{ name:"auto" } },
          }}
        />
      )}

      {err&&<div style={{ fontFamily:FONT,fontSize:13,color:"#EF4444",marginTop:14,textAlign:"center",lineHeight:1.4 }}>{err}</div>}

      <button type="submit" disabled={!stripe||loading}
        style={{ width:"100%",marginTop:20,padding:"17px 0",borderRadius:50,background:!stripe||loading?"#1a1a1a":`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:!stripe||loading?`1px solid ${BORDER}`:"none",fontFamily:FONT,fontWeight:800,fontSize:15,color:!stripe||loading?"#444":"#fff",cursor:!stripe||loading?"not-allowed":"pointer",letterSpacing:0.5,transition:"all 0.2s" }}>
        {loading?"Processing...":isTrial?"Start Free Trial":"Subscribe Now"}
      </button>
      <div style={{ fontFamily:FONT,fontSize:11,color:"#333",textAlign:"center",marginTop:12 }}>
        🔒 Secured by Stripe · Your card details never touch our servers
      </div>
    </form>
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
function AccountSettingsPage({ onBack, onLogout }) {
  const { user, profileImg, setProfileImg, isPremium } = useUser();
  const [apps,      setApps]      = useState({ appleHealth:true, fitbit:true, strava:false, myFitnessPal:true });
  const [subStatus, setSubStatus] = useState(null);
  const acctScrollRef = useScrollPos("account-settings");
  const [subPage, setSubPage] = useState(null);
  const toggleApp = k => setApps(p=>({...p,[k]:!p[k]}));

  useEffect(()=>{
    apiCall("/payments/status")
      .then(res=>setSubStatus(res?.data || null))
      .catch(()=>{});
  }, []);


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
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",letterSpacing:1,marginBottom:4 }}>{(user.name||"").toUpperCase()}</div>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:isPremium?PRIMARY:"#888",marginBottom:3 }}>{isPremium?"Premium Member":"Free Plan"}</div>
            {user.email&&<div style={{ fontFamily:FONT,fontSize:12,color:"#888" }}>{user.email}</div>}
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
            {(()=>{
              const wu = getUnitPref("vtrx_weight_unit","kg");
              const hu = getUnitPref("vtrx_height_unit","cm");
              const wDisp = kgToDisplay(user.weight, wu);
              // Handle legacy ft-format strings (e.g. "5'7") and corrupt small values
              const hIsLegacyFt = typeof user.height === "string" && user.height.includes("'");
              const hNum = parseFloat(user.height);
              const hDisp = hIsLegacyFt ? user.height : ((!isNaN(hNum) && hNum >= 50) ? cmToDisplay(hNum, hu) : "");
              const hUnit = hIsLegacyFt ? "ft" : hu;
              return [{lbl:"Age",val:user.age ? `${user.age} yrs` : "—"},{lbl:"Gender",val:user.gender||"—"},{lbl:"Weight",val:wDisp ? `${wDisp} ${wu}` : "—"},{lbl:"Height",val:hDisp ? `${hDisp} ${hUnit}` : "—"}];
            })().map((s,i)=>(
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
              <div style={{ fontFamily:FONT,fontSize:12,color:"#888888",marginTop:2 }}>{user.goal || "Not set"} · Change in Fitness Preferences</div>
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
        <div style={{ background:CARD,borderRadius:20,padding:"18px",overflow:"hidden",border:`1px solid ${BORDER}` }}>
          {/* Dynamic status card */}
          {isPremium ? (
            <div style={{ background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,borderRadius:14,padding:"16px 18px",display:"flex",alignItems:"center",gap:14,marginBottom:8 }}>
              <div style={{ width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#F59E0B" stroke="#F59E0B" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:2 }}>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff" }}>{subStatus?.plan==="annual"?"Annual Premium":"Monthly Premium"}</div>
                  <div style={{ background:"rgba(34,197,94,0.25)",border:"1px solid rgba(34,197,94,0.5)",borderRadius:20,padding:"2px 8px",fontFamily:FONT,fontWeight:700,fontSize:10,color:"#22C55E",letterSpacing:0.5 }}>ACTIVE</div>
                </div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.8)",marginTop:2 }}>
                  {subStatus?.plan==="annual"?"$69.99/year":"$9.99/month"}
                  {subStatus?.currentPeriodEnd ? ` · Renews ${new Date(subStatus.currentPeriodEnd).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}` : ""}
                  {subStatus?.cancelAtEnd ? " · Cancels at end of period" : ""}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ background:"rgba(255,255,255,0.04)",border:`1px solid ${BORDER}`,borderRadius:14,padding:"16px 18px",display:"flex",alignItems:"center",gap:14,marginBottom:8 }}>
              <div style={{ width:36,height:36,borderRadius:"50%",background:"rgba(255,255,255,0.08)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#fff",marginBottom:2 }}>Freemium Plan</div>
                <div style={{ fontFamily:FONT,fontSize:12,color:"#888" }}>Basic workouts &amp; logging · Upgrade to unlock all features</div>
              </div>
              <button onClick={()=>setSubPage("upgrade")} style={{ flexShrink:0,padding:"8px 14px",borderRadius:50,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:12,color:"#fff",cursor:"pointer",whiteSpace:"nowrap" }}>Upgrade</button>
            </div>
          )}
          {/* Billing menu rows */}
          {[
            { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>, label:"Payment Method",  color:"#fff",    page:"payment" },
            { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>, label:"Billing History", color:"#fff",    page:"billing"  },
            !isPremium && { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>, label:"Upgrade Plan", color:PRIMARY, page:"upgrade" },
            isPremium  && { ico:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>, label:"Cancel Subscription", color:"#EF4444", page:"cancel" },
          ].filter(Boolean).map((r,i,arr)=>(
            <button key={i} onClick={()=>setSubPage(r.page)} style={{ width:"100%",display:"flex",alignItems:"center",gap:14,padding:"14px 0",background:"none",border:"none",cursor:"pointer",borderTop:`1px solid ${BORDER}`,textAlign:"left" }}>
              <div style={{ width:28,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{r.ico}</div>
              <div style={{ flex:1,fontFamily:FONT,fontWeight:600,fontSize:15,color:r.color }}>{r.label}</div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          ))}
        </div>

        {/* ── LOGOUT ── */}
        <div style={{ margin:"28px 0 8px" }}>
          <button onClick={()=>setSubPage("logout")} style={{ width:"100%",padding:"16px 0",borderRadius:18,background:"#1c0a0a",border:"1px solid #EF444433",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#EF4444",letterSpacing:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            LOG OUT
          </button>
        </div>
      </div>

      {/* Logout confirmation */}
      {subPage==="logout"&&(
        <>
          <div onClick={()=>setSubPage(null)} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.8)",zIndex:60 }}/>
          <div style={{ position:"absolute",bottom:0,left:0,right:0,background:CARD,borderRadius:"24px 24px 0 0",padding:"28px 24px 44px",zIndex:61,border:`1px solid ${BORDER}`,borderBottom:"none" }}>
            <div style={{ textAlign:"center",marginBottom:24 }}>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",marginBottom:8 }}>Log out of VTRX?</div>
              <div style={{ fontFamily:FONT,fontSize:14,color:"#888" }}>You can log back in anytime.</div>
            </div>
            <button onClick={()=>{ setSubPage(null); onLogout&&onLogout(); }} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:"#EF4444",border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1.5,cursor:"pointer",marginBottom:10 }}>LOG OUT</button>
            <button onClick={()=>setSubPage(null)} style={{ width:"100%",padding:"14px 0",borderRadius:50,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888",cursor:"pointer" }}>Cancel</button>
          </div>
        </>
      )}
      {/* Sub-page overlays — AccountSettingsPage stays mounted preserving scroll */}
      {subPage==="personal"  && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><PersonalDetailsPage    onBack={()=>setSubPage(null)}/></div>}
      {subPage==="goal"      && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><FitnessGoalPage         onBack={()=>setSubPage(null)}/></div>}
      {subPage==="email"     && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><ChangeEmailPage         onBack={()=>setSubPage(null)}/></div>}
      {subPage==="password"  && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><ChangePasswordPage      onBack={()=>setSubPage(null)}/></div>}
      {subPage==="payment"   && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><PaymentMethodPage       onBack={()=>setSubPage(null)}/></div>}
      {subPage==="billing"   && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><BillingHistoryPage      onBack={()=>setSubPage(null)}/></div>}
      {subPage==="upgrade"   && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><UpgradePlanPage         onBack={()=>setSubPage(null)}/></div>}
      {subPage==="cancel"    && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><CancelSubscriptionPage  onBack={()=>setSubPage(null)}/></div>}
    </div>
  );
}

// ── FITNESS PREFERENCES ───────────────────────────────────────────────────────
function FitnessPreferencesPage({ onBack }) {
  const fitnessScrollRef = useScrollPos("fitness-prefs");
  const { user, setUser } = useUser();

  // Normalize environment value: onboarding stores "Full Gym"/"Mix of both", this page uses "Gym"/"Mix"
  const normalizeEnv = (v) => {
    if (!v) return "Gym";
    if (v === "Full Gym") return "Gym";
    if (v === "Mix of both") return "Mix";
    return v;
  };

  const [goal,  setGoal]  = useState(user.goal         || "Build Muscle");
  const [level, setLevel] = useState(user.fitnessLevel || user.level || "Intermediate");
  const [env,   setEnv]   = useState(normalizeEnv(user.location));
  const [days,  setDays]  = useState(Number(user.daysPerWeek || user.days) || 5);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    // Map env back to the canonical location value
    const locationVal = env === "Gym" ? "Full Gym" : env === "Mix" ? "Mix of both" : env;
    setUser(u => ({
      ...u,
      goal,
      fitnessLevel: level,
      level,
      daysPerWeek:  days,
      days,
      location:     locationVal,
      workoutLocation: locationVal,
    }));
    if (getAuthToken()) {
      try {
        await apiCall("/users/profile", {
          method: "PUT",
          body: JSON.stringify({ goal, fitnessLevel: level, daysPerWeek: days, location: locationVal }),
        });
      } catch (_e) {}
    }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };

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
          { label:"PRIMARY GOAL",        options:["Build Muscle","Lose Weight","Stay Active","Improve Endurance","Get Toned"], value:goal,  onChange:setGoal  },
          { label:"EXPERIENCE LEVEL",    options:["Beginner","Intermediate","Advanced"],                                      value:level, onChange:setLevel },
          { label:"PREFERRED ENVIRONMENT", options:["Gym","Home","Outdoors","Mix"],                                           value:env,   onChange:setEnv   },
        ].map((s,i)=>(
          <div key={i} style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:14 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>{s.label}</div>
            <ChipSel options={s.options} value={s.value} onChange={s.onChange}/>
          </div>
        ))}

        {/* Days per week */}
        <div style={{ background:"#ffffff",borderRadius:20,border:"1px solid #e8e8e8",padding:"18px",marginBottom:20 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888888",letterSpacing:1,marginBottom:14 }}>DAYS PER WEEK</div>
          <div style={{ display:"flex",gap:10 }}>
            {[2,3,4,5].map(d=>(
              <button key={d} onClick={()=>setDays(d)} style={{ flex:1,padding:"14px 0",borderRadius:14,border:`2px solid ${days===d?PRIMARY:BORDER}`,background:days===d?PRIMARY:"transparent",fontFamily:FONT,fontWeight:600,fontSize:16,color:days===d?"#fff":"#444",cursor:"pointer",transition:"all 0.2s" }}>{d}</button>
            ))}
          </div>
        </div>

        <button onClick={handleSave} disabled={saving} style={{ width:"100%",padding:"15px 0",borderRadius:50,background:saved?"#22C55E":saving?"#1a1a1a":`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:saving?`1px solid ${BORDER}`:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:saving?"#555":"#fff",letterSpacing:1,cursor:saving?"not-allowed":"pointer",transition:"background 0.3s",boxShadow:saving?"none":`0 4px 20px ${PRIMARY}44` }}>
          {saved ? "SAVED!" : saving ? "Saving..." : "SAVE PREFERENCES"}
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
          <button onClick={()=>openPaymentSheet()}
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



const TIERS = [
  { name:"Bronze",   min:0,    max:999,  color:"#CD7F32", icon:"Br", gradient:"linear-gradient(135deg,#8B4513,#CD7F32)" },
  { name:"Silver",   min:1000, max:2199, color:"#A8A8A8", icon:"Si", gradient:"linear-gradient(135deg,#707070,#C0C0C0)" },
  { name:"Gold",     min:2200, max:3999, color:"#FFD700", icon:"Go", gradient:"linear-gradient(135deg,#B8860B,#FFD700)" },
  { name:"Platinum", min:4000, max:6999, color:"#E5E4E2", icon:"Pt", gradient:"linear-gradient(135deg,#8E9EAB,#E5E4E2)" },
  { name:"Diamond",  min:7000, max:10999,color:"#B9F2FF", icon:"Di", gradient:"linear-gradient(135deg,#00B4DB,#B9F2FF)" },
  { name:"Elite",    min:11000,max:999999,color:"#FFB700",icon:"El",gradient:"linear-gradient(135deg,#F7971E,#FFD200)" },
];

function getTier(pts) {
  return TIERS.find(t=>pts>=t.min&&pts<=t.max) || TIERS[0];
}

function getNextTier(pts) {
  const idx = TIERS.findIndex(t=>pts>=t.min&&pts<=t.max);
  return idx < TIERS.length-1 ? TIERS[idx+1] : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// ── ACHIEVEMENTS ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
const ACHIEVEMENTS = [
  // STREAK
  { id:"s1", cat:"Streak",    label:"First Step",     desc:"Complete your first day",           bg:"#CA8A04", req:{type:"streak",n:1}  },
  { id:"s2", cat:"Streak",    label:"Week Warrior",   desc:"7-day streak",                      bg:"#F97316", req:{type:"streak",n:7}  },
  { id:"s3", cat:"Streak",    label:"Iron Habit",     desc:"30-day streak",                     bg:"#EF4444", req:{type:"streak",n:30} },
  { id:"s4", cat:"Streak",    label:"Unstoppable",    desc:"100-day streak",                    bg:"#DC2626", req:{type:"streak",n:100}},
  // WORKOUTS
  { id:"w1", cat:"Workouts",  label:"First Sweat",    desc:"Log your first workout",            bg:"#2563EB", req:{type:"workouts",n:1} },
  { id:"w2", cat:"Workouts",  label:"10 Down",        desc:"Complete 10 workouts",              bg:"#7C3AED", req:{type:"workouts",n:10}},
  { id:"w3", cat:"Workouts",  label:"Centurion",      desc:"Complete 100 workouts",             bg:"#6D28D9", req:{type:"workouts",n:100}},
  { id:"w4", cat:"Workouts",  label:"Early Bird",     desc:"Log a workout before 8am",          bg:"#0891B2", req:{type:"early",n:1}  },
  // NUTRITION
  { id:"n1", cat:"Nutrition", label:"Clean Eater",    desc:"Log meals 3 days in a row",         bg:"#16A34A", req:{type:"mealStreak",n:3} },
  { id:"n2", cat:"Nutrition", label:"Macro Master",   desc:"Log meals 14 days in a row",        bg:"#15803D", req:{type:"mealStreak",n:14}},
  { id:"n3", cat:"Nutrition", label:"Recipe Hunter",  desc:"Save 5 recipes",                   bg:"#166534", req:{type:"saved",n:5}  },
  // CHALLENGES
  { id:"c1", cat:"Challenges",label:"Challenger",     desc:"Join your first challenge",         bg:"#B45309", req:{type:"challenges",n:1}},
  { id:"c2", cat:"Challenges",label:"Committed",      desc:"Complete a 7-day challenge",        bg:"#92400E", req:{type:"chalDone",n:1} },
  // SPECIAL
  { id:"p1", cat:"Special",   label:"Profile Pro",    desc:"Complete your profile",             bg:"#374151", req:{type:"profile",n:1} },
  { id:"p2", cat:"Special",   label:"Streak Freeze",  desc:"Use your first streak freeze",      bg:"#1E40AF", req:{type:"freeze",n:1}  },
];

// Compute how many of a badge's requirement the user has met
function getProgress(req, stats) {
  switch(req.type) {
    case "streak":     return stats.streakDays;
    case "workouts":   return stats.workoutsTotal;
    case "early":      return stats.earlyWorkouts;
    case "mealStreak": return stats.mealStreakDays;
    case "saved":      return stats.savedRecipes;
    case "challenges": return stats.challengesJoined;
    case "chalDone":   return stats.challengesDone;
    case "profile":    return stats.profileComplete ? 1 : 0;
    case "freeze":     return stats.freezeUsed ? 1 : 0;
    default: return 0;
  }
}

function useAchievements(stats) {
  const [seenIds, setSeenIds] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem("vtrx_seen_achievements")||"[]"); } catch(_e){ return []; }
  });

  const earned = ACHIEVEMENTS.filter(a => getProgress(a.req, stats) >= a.req.n);
  const newlyEarned = earned.filter(a => !seenIds.includes(a.id));

  const markSeen = () => {
    const allIds = earned.map(a=>a.id);
    setSeenIds(allIds);
    try { localStorage.setItem("vtrx_seen_achievements", JSON.stringify(allIds)); } catch(_e){}
  };

  return { earned, newlyEarned, markSeen, getProgress };
}


function ProfilePage({ onBack, onLogout, onNavigate, streakDay=1, workoutsTotal=0 }) {
  const profileScrollRef = useScrollPos("profile-page");
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
          <div style={{ fontFamily:FONT,fontSize:13,color:"#888888",textAlign:"center" }}>
            Fitness Goal: <span style={{ color: user.goal ? PRIMARY : "#555", fontWeight: user.goal ? 700 : 400 }}>{user.goal || "Not set"}</span>
          </div>

        </div>

        {/* Achievements strip — live computed */}
        <div style={{ marginTop:18 }}/>
        {(()=>{
          const stats = {
          streakDays:     streakDay,
          workoutsTotal:  workoutsTotal,
          earlyWorkouts:  0,
          mealStreakDays: 0,
          savedRecipes:   0,
          challengesJoined:0,
          challengesDone: 0,
          profileComplete: !!(user?.name && user?.weight && user?.height),
          freezeUsed:     false,
          };
          const earned = ACHIEVEMENTS.filter(a=>getProgress(a.req,stats)>=a.req.n);
          const pts = earned.length * 200;
          // Show first 5 achievements (mix of earned and upcoming)
          const display = [...earned, ...ACHIEVEMENTS.filter(a=>!earned.find(e=>e.id===a.id))].slice(0,5);
          return (
          <div style={{ background:CARD,borderRadius:18,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:10 }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>Achievements</div>
            <div style={{ fontFamily:FONT,fontWeight:600,fontSize:12,color:PRIMARY }}>{earned.length}/{ACHIEVEMENTS.length} earned</div>
            </div>
            <div style={{ display:"flex",justifyContent:"space-around",marginBottom:12 }}>
            {display.map((a,i)=>{
              const prog = getProgress(a.req,stats);
              const isEarned = prog>=a.req.n;
              const pct = Math.min(prog/a.req.n,1);
              const r=20; const circ=2*Math.PI*r;
              return (
              <div key={i} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:5 }}>
                <div style={{ position:"relative",width:48,height:48 }}>
                <svg width={48} height={48} style={{ position:"absolute",inset:0,transform:"rotate(-90deg)" }}>
                  <circle cx={24} cy={24} r={r} fill="none" stroke="#1a1a1a" strokeWidth={3}/>
                  {!isEarned&&pct>0&&<circle cx={24} cy={24} r={r} fill="none" stroke={a.bg} strokeWidth={3}
                  strokeDasharray={circ} strokeDashoffset={circ*(1-pct)} strokeLinecap="round" opacity={0.6}/>}
                </svg>
                <div style={{ position:"absolute",inset:3,borderRadius:"50%",background:isEarned?a.bg:"#1a1a1a",border:`1.5px solid ${isEarned?a.bg:"#333"}`,display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.3s" }}>
                  {isEarned
                  ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                  }
                </div>
                </div>
                <div style={{ fontFamily:FONT,fontSize:8.5,color:isEarned?"#aaa":"#444",textAlign:"center",lineHeight:1.2,width:50 }}>{a.label}</div>
              </div>
              );
            })}
            </div>
            <div style={{ paddingTop:10,borderTop:`1px solid ${BORDER}`,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <div style={{ fontFamily:FONT,fontWeight:600,fontSize:12,color:"#888" }}>{pts.toLocaleString()} pts</div>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#aaa" }}>{earned.length} / {ACHIEVEMENTS.length} badges</div>
            </div>
          </div>
          );
        })()}

        {/* ── MENU ROWS ── */}
        <ProfileRow label="Account Settings"     sub="Manage your profile and preferences"     onPress={()=>setSubPage("account")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>}/>
        <ProfileRow label="My Challenges"
          sub="Coming soon — challenge mode launches next update"
          onPress={null}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>}
          right={<div style={{ background:"rgba(255,193,7,0.15)",border:"1px solid rgba(255,193,7,0.4)",borderRadius:20,padding:"3px 10px" }}><span style={{ fontFamily:FONT,fontWeight:700,fontSize:9,color:"#FFC107",letterSpacing:1 }}>COMING SOON</span></div>}
        />
        <ProfileRow label="Fitness Preferences"  sub="Workout intensity and training goals"       onPress={()=>setSubPage("fitness")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>}/>
        <ProfileRow label="Notifications"        sub="Workout reminders and achievements"         onPress={()=>setSubPage("notifSettings")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>}/>
        <ProfileRow label="Privacy & Security"   sub="Data protection and account security"      onPress={()=>setSubPage("privacy")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}/>
        <ProfileRow label="My Nutrition Plan"       sub="View or regenerate your 7-day meal plan"   onPress={()=>setSubPage("nutriRegen")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#A3E635" strokeWidth="1.8"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>}/>
        <ProfileRow label="My AI Workout Plan"    sub="View or regenerate your 4-week programme"  onPress={()=>onNavigate&&onNavigate("myPlan")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>}/>
        <ProfileRow label="Support"              sub="Help center and contact support"            onPress={()=>setSubPage("support")}
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}/>





      </div>
      {/* Sub-page overlays — ProfilePage stays mounted preserving scroll */}
      {subPage==="nutriRegen"   && <NutriRegenPage onBack={()=>setSubPage(null)} onNavigate={onNavigate}/>}
      {subPage==="progress"     && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><ProgressPhotosPage     onBack={()=>setSubPage(null)}/></div>}
      {subPage==="account"      && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><AccountSettingsPage    onBack={()=>setSubPage(null)} onLogout={onLogout}/></div>}
      {subPage==="fitness"      && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><FitnessPreferencesPage onBack={()=>setSubPage(null)}/></div>}
      {subPage==="notifSettings"&& <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><NotifSettingsPage     onBack={()=>setSubPage(null)}/></div>}
      {subPage==="privacy"      && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><PrivacyPage            onBack={()=>setSubPage(null)}/></div>}
      {subPage==="support"      && <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}><SupportPage            onBack={()=>setSubPage(null)}/></div>}
    </div>


  );
}


// ─────────────────────────────────────────────────────────────────────────────
// ── NUTRITION HUB ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// All available meal options pool (used for swapping)
const MEAL_OPTIONS = {
  breakfast: [
    { name:"Greek Yogurt Protein Bowl",  cal:320, protein:28, prep:"5 min",  img:"https://images.unsplash.com/photo-1488477181946-6428a0291777?w=200&q=80" },
    { name:"Egg White Veggie Omelette",  cal:280, protein:32, prep:"12 min", img:"https://images.unsplash.com/photo-1510693206972-df098062cb71?w=200&q=80" },
    { name:"Avocado Toast & Eggs",       cal:350, protein:18, prep:"10 min", img:"https://images.unsplash.com/photo-1525351484163-7529414344d8?w=200&q=80" },
    { name:"Protein Smoothie Bowl",      cal:340, protein:30, prep:"5 min",  img:"https://images.unsplash.com/photo-1547592180-85f173990554?w=200&q=80" },
  ],
  lunch: [
    { name:"Grilled Chicken Power Bowl", cal:485, protein:42, prep:"20 min", img:"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=200&q=80" },
    { name:"Turkey & Veggie Stir Fry",   cal:390, protein:36, prep:"18 min", img:"https://images.unsplash.com/photo-1540420773420-3366772f4999?w=200&q=80" },
    { name:"Grilled Salmon Bowl",        cal:435, protein:38, prep:"25 min", img:"https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=200&q=80" },
    { name:"Tuna Salad Wrap",            cal:380, protein:35, prep:"10 min", img:"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=200&q=80" },
  ],
  snack: [
    { name:"Protein Bar",                cal:220, protein:20, prep:"0 min",  img:"https://images.unsplash.com/photo-1547592180-85f173990554?w=200&q=80" },
    { name:"Greek Yogurt & Berries",     cal:180, protein:15, prep:"2 min",  img:"https://images.unsplash.com/photo-1488477181946-6428a0291777?w=200&q=80" },
    { name:"Apple & Almond Butter",      cal:200, protein:6,  prep:"2 min",  img:"https://images.unsplash.com/photo-1610832958506-aa56368176cf?w=200&q=80" },
    { name:"Cottage Cheese & Fruit",     cal:160, protein:18, prep:"2 min",  img:"https://images.unsplash.com/photo-1547592180-85f173990554?w=200&q=80" },
  ],
  dinner: [
    { name:"Grilled Salmon Bowl",        cal:435, protein:38, prep:"25 min", img:"https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=200&q=80" },
    { name:"Grilled Chicken Power Bowl", cal:485, protein:42, prep:"20 min", img:"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=200&q=80" },
    { name:"Turkey & Veggie Stir Fry",   cal:390, protein:36, prep:"18 min", img:"https://images.unsplash.com/photo-1540420773420-3366772f4999?w=200&q=80" },
    { name:"Beef & Broccoli Bowl",       cal:520, protein:44, prep:"25 min", img:"https://images.unsplash.com/photo-1547592166-23ac45744acd?w=200&q=80" },
  ],
};

// 7-day plan: each day has breakfast/lunch/snack/dinner indices into MEAL_OPTIONS
const WEEKLY_MEAL_PLAN = [
  // Mon
  [{ time:"Breakfast", slot:"breakfast", idx:0 },{ time:"Lunch", slot:"lunch", idx:0 },{ time:"Snack", slot:"snack", idx:0 },{ time:"Dinner", slot:"dinner", idx:0 }],
  // Tue
  [{ time:"Breakfast", slot:"breakfast", idx:1 },{ time:"Lunch", slot:"lunch", idx:1 },{ time:"Snack", slot:"snack", idx:1 },{ time:"Dinner", slot:"dinner", idx:1 }],
  // Wed
  [{ time:"Breakfast", slot:"breakfast", idx:2 },{ time:"Lunch", slot:"lunch", idx:2 },{ time:"Snack", slot:"snack", idx:2 },{ time:"Dinner", slot:"dinner", idx:2 }],
  // Thu
  [{ time:"Breakfast", slot:"breakfast", idx:3 },{ time:"Lunch", slot:"lunch", idx:0 },{ time:"Snack", slot:"snack", idx:3 },{ time:"Dinner", slot:"dinner", idx:3 }],
  // Fri
  [{ time:"Breakfast", slot:"breakfast", idx:0 },{ time:"Lunch", slot:"lunch", idx:2 },{ time:"Snack", slot:"snack", idx:0 },{ time:"Dinner", slot:"dinner", idx:0 }],
  // Sat
  [{ time:"Breakfast", slot:"breakfast", idx:1 },{ time:"Lunch", slot:"lunch", idx:3 },{ time:"Snack", slot:"snack", idx:2 },{ time:"Dinner", slot:"dinner", idx:1 }],
  // Sun
  [{ time:"Breakfast", slot:"breakfast", idx:2 },{ time:"Lunch", slot:"lunch", idx:1 },{ time:"Snack", slot:"snack", idx:1 },{ time:"Dinner", slot:"dinner", idx:2 }],
];

// Keep backward-compat flat MEAL_PLAN for any legacy usage
const MEAL_PLAN = MEAL_OPTIONS.breakfast.slice(0,1).concat(MEAL_OPTIONS.lunch.slice(0,1)).concat(MEAL_OPTIONS.snack.slice(0,1)).concat(MEAL_OPTIONS.dinner.slice(0,1)).map((m,i)=>({...m, time:["Breakfast","Lunch","Snack","Dinner"][i]}));

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

// Assign a recipe to a meal slot based on name keywords and calories
const getRecipeSlot = (r) => {
  const name = (r.name||'').toLowerCase();
  const cal  = r.cal || 0;
  if (/oat|pancake|omelette|toast|yogurt|smoothie bowl|chia|overnight|muffin|cottage|porridge/.test(name)) return 'breakfast';
  if (/shake|bar/.test(name) || cal < 260) return 'snack';
  if (/soup|stir.?fry|sheet pan|stuffed|taco|asparagus|baked|roast/.test(name) || cal >= 420) return 'dinner';
  return 'lunch';
};

const INGR_CATS = [
  ['Proteins',       /chicken|beef|salmon|turkey|tuna|shrimp|egg|yogurt|protein|tofu|cottage|whey|mince|ground/i],
  ['Vegetables',     /broccoli|spinach|pepper|tomato|onion|garlic|carrot|asparagus|cabbage|cauliflower|mushroom|cucumber|avocado|celery|corn|bean|lentil|chickpea|coriander|parsley/i],
  ['Carbs & Grains', /rice|oat|quinoa|bread|potato|pasta|tortilla|sweet potato|corn/i],
  ['Fruits',         /banana|berr|mango|lime|lemon|apple|peach|pear/i],
  ['Dairy',          /milk|cheese|butter|cream|feta/i],
];
const categoriseIngredient = (ing) => INGR_CATS.find(([,re])=>re.test(ing))?.[0] || 'Pantry';

const buildGroceryListFromRecipes = (recipes) => {
  const seen = new Set();
  const groups = {};
  const unique = [...new Map(recipes.filter(Boolean).map(r=>[r.id,r])).values()];
  unique.forEach(r=>{
    (r.ingredients||[]).forEach(ing=>{
      const key = ing.toLowerCase().trim();
      if (seen.has(key)) return;
      seen.add(key);
      const cat = categoriseIngredient(ing);
      (groups[cat]=groups[cat]||[]).push({ name:ing });
    });
  });
  const ORDER = ['Proteins','Vegetables','Carbs & Grains','Fruits','Dairy','Pantry'];
  return ORDER.filter(c=>groups[c]).map(c=>({ category:c, items:groups[c] }));
};

function GroceryTab({ checkedGrocery, setCheckedGrocery, groceryList }) {
  const list = groceryList && groceryList.length > 0 ? groceryList : GROCERY_LIST;
  const totalItems   = list.reduce((s,cat)=>s+cat.items.length,0);
  const checkedCount = checkedGrocery.length;
  const pct = totalItems > 0 ? Math.round((checkedCount/totalItems)*100) : 0;
  return (
    <div>
      <div style={{ background:CARD,borderRadius:16,padding:"14px 18px",marginBottom:12,border:`1px solid ${BORDER}` }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>Shopping Progress</div>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:PRIMARY }}>{checkedCount}/{totalItems}</div>
        </div>
        <div style={{ height:8,background:"#1a1a1a",borderRadius:8,overflow:"hidden" }}>
          <div style={{ height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${PRIMARY},#22C55E)`,borderRadius:8,transition:"width 0.4s ease" }}/>
        </div>
        {pct===100&&<div style={{ fontFamily:FONT,fontSize:11,color:"#22C55E",textAlign:"center",marginTop:8,fontWeight:700 }}>All items collected!</div>}
      </div>
      {list.map((cat,i)=>(
        <div key={i} style={{ background:"#fff",borderRadius:16,padding:"14px 16px",marginBottom:12 }}>
          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888",letterSpacing:1,marginBottom:10 }}>{cat.category.toUpperCase()}</div>
          {cat.items.map((item,j)=>{
            const gkey=`${cat.category}::${item.name||item}`;
            const isChecked=checkedGrocery.includes(gkey);
            return (
              <div key={j} onClick={()=>setCheckedGrocery(p=>p.includes(gkey)?p.filter(x=>x!==gkey):[...p,gkey])}
                style={{ display:"flex",alignItems:"center",gap:12,padding:"11px 0",borderBottom:j<cat.items.length-1?"1px solid #f0f0f0":"none",cursor:"pointer" }}>
                <div style={{ width:22,height:22,borderRadius:6,border:`2px solid ${isChecked?PRIMARY:"#ddd"}`,background:isChecked?PRIMARY:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s" }}>
                  {isChecked&&<svg width="11" height="9" viewBox="0 0 11 9" fill="none" stroke="#fff" strokeWidth="2.5"><polyline points="1,4.5 4,7.5 10,1"/></svg>}
                </div>
                <div style={{ fontFamily:FONT,fontSize:14,color:isChecked?"#aaa":"#111",textDecoration:isChecked?"line-through":"none",flex:1 }}>{item.name||item}{item.qty?<span style={{color:"#888",fontSize:12}}> ({item.qty})</span>:null}</div>
                {isChecked&&<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}


function NutritionHub({ onBack, energyKey, onLogout }) {
  const { isPremium, setIsPremium } = useUser();
  const [showProfile, setShowProfile]   = useState(false);
  const [showUpgrade, setShowUpgrade]   = useState(false);
  const [subTab, setSubTab]             = useState(0); // 0=Discover 1=Plan 2=Grocery 3=Saved
  const [filter, setFilter]           = useState("All");
  const scrollRef = useScrollPos("nutrition-" + subTab);
  const [search, setSearch]           = useState("");
  // API-backed recipe state
  const [apiRecipes,     setApiRecipes]     = useState([]);
  const [loadingRecipes, setLoadingRecipes] = useState(false);
  const [totalRecipes,   setTotalRecipes]   = useState(0);
  const [recipePage,     setRecipePage]     = useState(1);
  // Categorized recipe sections (11 fixed categories, <=10 recipes each) — default Discover view
  const [categorized,        setCategorized]        = useState([]);
  const [categorizedLoading, setCategorizedLoading]  = useState(false);
  const [savedRecipes,   setSavedRecipes]   = useState([]);
  const [savedSet,       setSavedSet]       = useState(new Set());
  const [selectedRecipe, setSelectedRecipe] = useState(null); // recipe object
  const [saveMsg, setSaveMsg]         = useState("");
  const [swapTarget, setSwapTarget]   = useState(null);
  const [bannerOpen, setBannerOpen]   = useState(true); // AI banner collapsed state
  const [checkedGrocery, setCheckedGrocery] = useState([]);
  const [selectedDay, setSelectedDay] = useState(new Date().getDay()===0?6:new Date().getDay()-1);
  // mealSwaps[dayIdx][slotLabel] = recipe object override for that slot
  const [mealSwaps, setMealSwaps] = useState({});

  // ── AI Nutrition Plan state ───────────────────────────────────────────────
  const { user: currentUser } = useUser();
  const [aiNutritionPlan,    setAiNutritionPlan]    = useState(null);
  const [aiPlanLoading,      setAiPlanLoading]       = useState(false);
  const [aiPlanGenerating,   setAiPlanGenerating]    = useState(false);
  const [aiPlanError,        setAiPlanError]         = useState(null);
  const [todayFoodLogs,      setTodayFoodLogs]       = useState([]);
  const [loggedMeals,        setLoggedMeals]         = useState(new Set());
  const [expandedPlanMeal,   setExpandedPlanMeal]    = useState(null);
  const [confirmNutriRegen,  setConfirmNutriRegen]   = useState(false);
  const [aiShoppingChecked,  setAiShoppingChecked]   = useState(new Set());

  // ── Onboarding nutrition summary ──────────────────────────────────────────────
  const [onboardingNutrition, setOnboardingNutrition] = useState(null);
  const [onboardingNutritionLoading, setOnboardingNutritionLoading] = useState(false);
  const [onboardingNutritionTwText, setOnboardingNutritionTwText] = useState("");
  const [onboardingNutritionTwDone, setOnboardingNutritionTwDone] = useState(false);
  const [nutritionSummaryExpanded, setNutritionSummaryExpanded] = useState(true);

  // Register browser back-button handler when a detail overlay is open
  useEffect(() => {
    const hasOverlay = !!selectedRecipe || showProfile || showUpgrade;
    if (!hasOverlay) return;
    _backHandler = () => {
      if (selectedRecipe) { setSelectedRecipe(null); return; }
      if (showUpgrade)    { setShowUpgrade(false);    return; }
      if (showProfile)    { setShowProfile(false);    return; }
    };
    return () => { _backHandler = null; };
  }, [selectedRecipe, showProfile, showUpgrade]);

  useEffect(() => {
    if (!getAuthToken()) return;
    setOnboardingNutritionLoading(true);
    apiCall('/ai/onboarding-analysis')
      .then(res => { if (res?.data?.nutritionSummary) setOnboardingNutrition(res.data.nutritionSummary); })
      .catch(() => {})
      .finally(() => setOnboardingNutritionLoading(false));
  }, []);

  useEffect(() => {
    if (!onboardingNutrition || onboardingNutritionLoading) return;
    setOnboardingNutritionTwText(''); setOnboardingNutritionTwDone(false);
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setOnboardingNutritionTwText(onboardingNutrition.slice(0, i));
      if (i >= onboardingNutrition.length) { clearInterval(iv); setOnboardingNutritionTwDone(true); }
    }, 14);
    return () => clearInterval(iv);
  }, [onboardingNutrition, onboardingNutritionLoading]);

  const AI_PLAN_DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const AI_PLAN_SHORT = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  const loadAiNutritionPlan = async () => {
    setAiPlanLoading(true); setAiPlanError(null);
    try {
      const res = await apiCall('/nutrition/active-plan');
      if (res?.data?.plan) setAiNutritionPlan(res.data.plan);
    } catch(_) { setAiPlanError('Could not load plan.'); }
    setAiPlanLoading(false);
  };

  const loadTodayFoodLogs = async () => {
    try {
      const res = await apiCall('/nutrition/food-log/today');
      if (res?.data?.logs) setTodayFoodLogs(res.data.logs);
    } catch(_) {}
  };

  const generateAiNutritionPlan = async () => {
    setAiPlanGenerating(true); setAiPlanError(null); setConfirmNutriRegen(false);
    try {
      const res = await apiCall('/nutrition/generate-plan', { method: 'POST' });
      if (res?.data?.plan) setAiNutritionPlan(res.data.plan);
    } catch(_) { setAiPlanError('Generation failed — please try again.'); }
    setAiPlanGenerating(false);
  };

  const logPlanMeal = async (meal, dayKey) => {
    const mealId = `${dayKey}-${meal.meal_name}-${meal.recipe_name}`;
    setLoggedMeals(prev => new Set([...prev, mealId]));
    try {
      await apiCall('/nutrition/food-log', { method:'POST', body:JSON.stringify({ mealName:meal.meal_name, recipeName:meal.recipe_name, calories:meal.calories, proteinG:meal.protein_g, carbsG:meal.carbs_g, fatG:meal.fat_g, fromPlan:true }) });
      loadTodayFoodLogs();
    } catch(_) {}
  };

  useEffect(() => {
    if (subTab === 1 && !aiNutritionPlan && !aiPlanLoading && getAuthToken()) {
      loadAiNutritionPlan();
      loadTodayFoodLogs();
    }
  }, [subTab]);

  const todayConsumed = todayFoodLogs.reduce((a, l) => ({ cal:a.cal+(l.calories||0), protein:a.protein+(l.proteinG||0), carbs:a.carbs+(l.carbsG||0), fat:a.fat+(l.fatG||0) }), {cal:0,protein:0,carbs:0,fat:0});
  const trackPref = currentUser?.trackingPreference || 'no_not_interested';
  const showFullTracking = trackPref === 'yes_both';
  const showCalTracking  = trackPref === 'yes_both' || trackPref === 'only_calories' || trackPref === 'no_but_interested';
  const calTarget = aiNutritionPlan?.daily_targets?.calories || currentUser?.dailyCalorieTarget || 2000;

  // Fetch personalised recipes (≤10) from backend whenever tab or user changes
  useEffect(()=>{
    if (!getAuthToken()) return;
    const now = Date.now();
    const cacheKey = `${filter}_${currentUser?.id}`;
    const hit = _nutritionCache[cacheKey];
    if (hit && (now - hit.fetchedAt) < CACHE_TTL_MS) {
      setApiRecipes(hit.recipes);
      setTotalRecipes(hit.total);
      return;
    }
    setLoadingRecipes(true);
    const tab = FILTER_TAB_MAP[filter] || 'all';
    apiCall(`/nutrition/recipes/personalised?tab=${tab}`)
      .then(d=>{
        if(d?.data?.recipes) {
          const recipes = d.data.recipes.map(normalizeRecipe);
          const total = d.data.total || 0;
          setApiRecipes(recipes);
          setTotalRecipes(total);
          _nutritionCache[cacheKey] = { recipes, total, fetchedAt: Date.now() };
        }
      })
      .catch(()=>{})
      .finally(()=>setLoadingRecipes(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[filter, currentUser?.id]);

  // Fetch categorized recipe sections (11 fixed categories, <=10 each) once —
  // this is the default Discover view shown when there's no active search/filter.
  useEffect(()=>{
    if (!getAuthToken()) return;
    const now = Date.now();
    if (_categorizedCache.data && (now - _categorizedCache.fetchedAt) < CACHE_TTL_MS) {
      setCategorized(_categorizedCache.data);
      return;
    }
    setCategorizedLoading(true);
    apiCall('/nutrition/recipes/categorized')
      .then(d=>{
        const cats = (d?.data?.categories || [])
          .map(c => ({ ...c, recipes: (c.recipes||[]).map(normalizeRecipe) }))
          .filter(c => c.recipes.length > 0);
        setCategorized(cats);
        _categorizedCache.data = cats;
        _categorizedCache.fetchedAt = Date.now();
      })
      .catch(()=>{})
      .finally(()=>setCategorizedLoading(false));
  },[]);

  // Fetch saved recipes once on mount
  useEffect(()=>{
    if (!getAuthToken()) return;
    const now = Date.now();
    if (_savedCache.data && (now - _savedCache.fetchedAt) < CACHE_TTL_MS) {
      setSavedRecipes(_savedCache.data);
      setSavedSet(new Set(_savedCache.data.map(r=>String(r.id))));
      return;
    }
    apiCall('/nutrition/saved')
      .then(d=>{
        if(d?.data?.recipes?.length) {
          const norm = d.data.recipes.map(normalizeRecipe);
          setSavedRecipes(norm);
          setSavedSet(new Set(norm.map(r=>String(r.id))));
          _savedCache.data = norm;
          _savedCache.fetchedAt = Date.now();
        }
      })
      .catch(()=>{});
  },[]);

  const handleFilterChange = (f) => { setFilter(f); setRecipePage(1); };

  const toggleSave = (recipe) => {
    const sid = String(recipe.id);
    const isSaved = savedSet.has(sid);
    if (!isPremium && !isSaved && savedSet.size >= 3) {
      setSaveMsg("Free plan: 3 saved recipes max. Upgrade for unlimited saves.");
      setTimeout(()=>setSaveMsg(""), 3000);
      return;
    }
    if (isSaved) {
      setSavedSet(p=>{ const n=new Set(p); n.delete(sid); return n; });
      setSavedRecipes(p=>p.filter(r=>String(r.id)!==sid));
      if (!DEMO_MODE && getAuthToken()) apiCall(`/nutrition/saved/${sid}`, { method:"DELETE" }).catch(()=>{});
    } else {
      setSavedSet(p=>new Set([...p, sid]));
      setSavedRecipes(p=>[recipe,...p]);
      if (!DEMO_MODE && getAuthToken()) apiCall('/nutrition/saved', { method:'POST', body:JSON.stringify({ recipeId:sid }) }).catch(()=>{});
    }
  };

  const aiSug = AI_SUGGESTIONS[energyKey] || AI_SUGGESTIONS.okay;

  if (showProfile) return <ProfilePage onBack={()=>setShowProfile(false)} onLogout={()=>{ setShowProfile(false); onLogout&&onLogout(); }}/>;
  if (showUpgrade) return <UpgradePlanPage onBack={()=>setShowUpgrade(false)}/>;

  const displayRecipes = apiRecipes.length > 0 ? apiRecipes : RECIPES.map(normalizeRecipe);
  // Diet filter is applied server-side; apply local search and dietary restriction filtering here
  const filtered = displayRecipes.filter(r => {
    if (search && !(r.name||'').toLowerCase().includes(search.toLowerCase())) return false;
    // Filter out recipes that violate user's dietary restrictions
    const restrictions = currentUser?.dietaryRestrictions || [];
    if (restrictions.includes('vegan') && (r.tags||[]).some(t => /meat|chicken|beef|pork|fish|egg|dairy|milk|cheese/i.test(t))) return false;
    if (restrictions.includes('vegetarian') && (r.tags||[]).some(t => /meat|chicken|beef|pork|fish/i.test(t))) return false;
    if (restrictions.includes('gluten_free') && (r.tags||[]).some(t => /gluten|wheat|bread|pasta/i.test(t))) return false;
    if (restrictions.includes('dairy_free') && (r.tags||[]).some(t => /dairy|milk|cheese|yogurt/i.test(t))) return false;
    return true;
  });

  // ── Recommended recipes — computed once here, reused for strip + dedup ──────
  const _recGoal = currentUser?.nutritionGoal || currentUser?.goal || '';
  const _isDessert = (r) => /cookie|cookies|cake|brownie|browni|muffin|donut|doughnut|chocolate chip|pudding|dessert|tart|pastry|candy/i.test(r.name || '');
  const recommended = (() => {
    if (!displayRecipes.length) return [];
    const restrictions = currentUser?.dietaryRestrictions || [];
    const dietFiltered = displayRecipes.filter(r => {
      if (restrictions.includes('vegan') && (r.tags||[]).some(t => /meat|chicken|beef|pork|fish|egg|dairy|milk|cheese/i.test(t))) return false;
      if (restrictions.includes('vegetarian') && (r.tags||[]).some(t => /meat|chicken|beef|pork|fish/i.test(t))) return false;
      if (restrictions.includes('gluten_free') && (r.tags||[]).some(t => /gluten|wheat|bread|pasta/i.test(t))) return false;
      if (restrictions.includes('dairy_free') && (r.tags||[]).some(t => /dairy|milk|cheese|yogurt/i.test(t))) return false;
      return true;
    });
    let pool = [...dietFiltered];
    if (_recGoal === 'lose_fat' || _recGoal === 'lose_weight') {
      pool = pool.filter(r => (r.cal || 999) <= 600);
      const nonDesserts = pool.filter(r => !_isDessert(r));
      const desserts    = pool.filter(r => _isDessert(r));
      const sortByCal   = (a, b) => ((a.cal||0) - (b.cal||0)) || ((b.protein||0) - (a.protein||0));
      pool = [...nonDesserts.sort(sortByCal), ...desserts.sort(sortByCal)];
    } else if (_recGoal === 'build_muscle') {
      pool = pool.filter(r => (r.protein||0) >= 20 || (r.tags||[]).some(t => /protein|chicken|beef|egg|meat/i.test(t)));
      const nonDesserts = pool.filter(r => !_isDessert(r));
      const desserts    = pool.filter(r => _isDessert(r));
      pool = [...nonDesserts.sort((a,b) => (b.protein||0)-(a.protein||0)), ...desserts];
    } else if (_recGoal === 'eat_clean') {
      const nonDesserts = pool.filter(r => !_isDessert(r));
      pool = nonDesserts.length >= 3 ? nonDesserts : pool.filter(r => !_isDessert(r) || (r.cal||999) < 350);
    } else if (_recGoal === 'improve_energy') {
      const nonHighSugar = pool.filter(r => !(_isDessert(r) && (r.cal||0) > 350));
      pool = nonHighSugar.length >= 3 ? nonHighSugar : pool;
      pool.sort((a,b) => (b.protein||0)-(a.protein||0));
    } else {
      // Default: protein-first, non-desserts first
      const nonDesserts = pool.filter(r => !_isDessert(r));
      const desserts    = pool.filter(r => _isDessert(r));
      pool = [...nonDesserts.sort((a,b)=>(b.protein||0)-(a.protein||0)), ...desserts];
    }
    return (pool.length >= 3 ? pool : dietFiltered.sort((a,b)=>(b.protein||0)-(a.protein||0))).slice(0, 5);
  })();
  const recommendedIds = new Set(recommended.map(r => String(r.id)));
  // Main grid excludes already-recommended recipes so users never see the same recipe twice
  const filteredGrid = filtered.filter(r => !recommendedIds.has(String(r.id)));

  // Fixed-width tile for horizontal-scroll category rows (mirrors the "Recommended" tile style)
  const renderCategoryTile = (r, i) => {
    const isSaved = savedSet.has(String(r.id));
    return (
      <div key={r.id||i} onClick={()=>setSelectedRecipe(r)}
        style={{ width:160,minWidth:160,flexShrink:0,background:"#fff",borderRadius:14,overflow:"hidden",cursor:"pointer",border:`1px solid ${BORDER}` }}>
        <div style={{ height:110,overflow:"hidden",position:"relative" }}>
          {r.img
            ? <img src={r.img} alt="" width={160} height={110} loading="lazy" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
            : <div style={{ width:"100%",height:"100%",background:"linear-gradient(135deg,#1a1a2e,#16213e)",display:"flex",alignItems:"center",justifyContent:"center",padding:"8px" }}>
                <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#fff",textAlign:"center",lineHeight:1.3 }}>{r.name}</span>
              </div>
          }
          <button onClick={e=>{ e.stopPropagation(); toggleSave(r); }} style={{ position:"absolute",top:8,right:8,width:28,height:28,borderRadius:"50%",background:"rgba(0,0,0,0.5)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isSaved?"#00A3FF":"none"} stroke="#fff" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
          </button>
        </div>
        <div style={{ padding:"10px" }}>
          <div style={{ fontFamily:FONT,fontSize:12,fontWeight:700,color:"#111",marginBottom:4,lineHeight:1.3 }}>{r.name}</div>
          <div style={{ display:"flex",gap:6 }}>
            <span style={{ fontFamily:FONT,fontSize:10,color:"#EF4444",fontWeight:600 }}>{r.cal} cal</span>
            <span style={{ fontFamily:FONT,fontSize:10,color:PRIMARY,fontWeight:600 }}>{r.protein}g protein</span>
          </div>
        </div>
      </div>
    );
  };
  // Categorized sections are the default Discover view; an active search or a
  // non-"All" filter pill switches to the existing flat filtered grid below.
  const showCategorizedSections = !search && filter === "All";

  // ── Meal Plan helpers ─────────────────────────────────────────────────────────
  const MEAL_SLOTS = ['breakfast','lunch','snack','dinner'];
  const SLOT_LABELS = { breakfast:'Breakfast', lunch:'Lunch', snack:'Snack', dinner:'Dinner' };

  const recipesBySlot = { breakfast:[], lunch:[], snack:[], dinner:[] };
  displayRecipes.forEach(r => {
    const s = getRecipeSlot(r);
    if (recipesBySlot[s]) recipesBySlot[s].push(r);
  });
  // Fall back to a single placeholder so slots never render empty
  MEAL_SLOTS.forEach(s => {
    if (!recipesBySlot[s].length) recipesBySlot[s] = displayRecipes.slice(0, 1);
  });

  const getMealForDay = (dayIdx, slotLabel) => {
    const override = mealSwaps[dayIdx]?.[slotLabel];
    if (override) return override;
    const pool = recipesBySlot[slotLabel];
    return pool.length ? pool[dayIdx % pool.length] : null;
  };

  const swapMeal = (dayIdx, slotLabel) => {
    const pool = recipesBySlot[slotLabel];
    if (pool.length < 2) return;
    const cur = getMealForDay(dayIdx, slotLabel);
    const curIdx = pool.findIndex(r => r.id === cur?.id);
    const next = pool[(curIdx + 1) % pool.length];
    setMealSwaps(p => ({ ...p, [dayIdx]: { ...(p[dayIdx]||{}), [slotLabel]: next } }));
  };

  // Dates for Mon–Sun of this week
  const weekDates = (() => {
    const today = new Date();
    const dow = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d.getDate();
    });
  })();

  // All meals for the full week — used to build grocery list
  const weekMeals = [];
  for (let d = 0; d < 7; d++) {
    MEAL_SLOTS.forEach(s => { const m = getMealForDay(d, s); if (m) weekMeals.push(m); });
  }
  const computedGroceryList = buildGroceryListFromRecipes(weekMeals);
  // ─────────────────────────────────────────────────────────────────────────────

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
        {TABS.map((t,i)=>{
          const locked = (i===1||i===2) && !isPremium;
          return (
            <button key={i} onClick={()=>{ if(locked){ setShowUpgrade(true); return; } setSubTab(i); }}
              style={{ flex:1,padding:"8px 4px",borderRadius:12,border:`1.5px solid ${subTab===i?PRIMARY:BORDER}`,background:subTab===i?`${PRIMARY}18`:"transparent",display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer",transition:"all 0.2s" }}>
              <span style={{ color:subTab===i?PRIMARY:locked?"#555":"#555",display:"flex",position:"relative" }}>
                {t.icon}
                {locked&&<span style={{ position:"absolute",top:-5,right:-7,width:13,height:13,borderRadius:"50%",background:"#F59E0B",display:"flex",alignItems:"center",justifyContent:"center" }}><svg width="7" height="7" viewBox="0 0 8 9" fill="none"><rect x="1" y="4" width="6" height="5" rx="1" fill="#000"/><path d="M2.5 4V3a1.5 1.5 0 013 0v1" stroke="#000" strokeWidth="1.2"/></svg></span>}
              </span>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:subTab===i?PRIMARY:locked?"#555":"#555",letterSpacing:0.3 }}>{t.label}</span>
            </button>
          );
        })}
      </div>

      <div ref={scrollRef} style={{ flex:1,overflowY:"auto",padding:"0 16px 80px" }}>
        {subTab===0 && (
          <div>

            {/* ── RECOMMENDED FOR YOU ─────────────────────────────────────── */}
            {recommended.length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10 }}>
                  <div>
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff" }}>Recommended For You</div>
                    <div style={{ fontFamily:FONT,fontSize:11,color:"#555",marginTop:2 }}>
                      {_recGoal === 'lose_fat' || _recGoal === 'lose_weight' ? 'Low-calorie picks for fat loss' : _recGoal === 'build_muscle' ? 'High-protein picks for muscle gain' : _recGoal === 'eat_clean' ? 'Clean eating choices' : 'Personalised to your goals'}
                    </div>
                  </div>
                  <div style={{ background:`${PRIMARY}18`,borderRadius:20,padding:"4px 10px" }}>
                    <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:PRIMARY }}>AI Picks</span>
                  </div>
                </div>
                <div style={{ display:"flex",gap:12,overflowX:"auto",paddingBottom:4,scrollbarWidth:"none",msOverflowStyle:"none" }}>
                  {recommended.map((r,i) => (
                    <div key={i} onClick={()=>setSelectedRecipe(r)}
                      style={{ width:160,minWidth:160,flexShrink:0,background:"#fff",borderRadius:14,overflow:"hidden",cursor:"pointer",border:`1px solid ${BORDER}` }}>
                      <div style={{ height:110,overflow:"hidden",position:"relative" }}>
                        {r.img
                          ? <img src={r.img} alt={r.name} width={160} height={110} loading="lazy" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                          : <div style={{ width:"100%",height:"100%",background:"linear-gradient(135deg,#1a1a2e,#16213e)",display:"flex",alignItems:"center",justifyContent:"center",padding:"8px" }}>
                              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#fff",textAlign:"center",lineHeight:1.3 }}>{r.name}</span>
                            </div>
                        }
                      </div>
                      <div style={{ padding:"10px" }}>
                        <div style={{ fontFamily:FONT,fontSize:12,fontWeight:700,color:"#111",marginBottom:4,lineHeight:1.3 }}>{r.name}</div>
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

            {/* ── FREE AI NUTRITION SUMMARY ────────────────────────────────── */}
            {(onboardingNutrition || onboardingNutritionLoading) && (
              <div style={{ background:`linear-gradient(135deg,#0a1a0e,#0d2015)`,border:`1px solid #22C55E33`,borderRadius:18,marginBottom:14,overflow:"hidden" }}>
                <div onClick={()=>setNutritionSummaryExpanded(e=>!e)}
                  style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",cursor:"pointer" }}>
                  <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                    <div style={{ width:30,height:30,borderRadius:10,background:"linear-gradient(135deg,#16A34A,#15803D)",display:"flex",alignItems:"center",justifyContent:"center" }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </div>
                    <div>
                      <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff" }}>Your AI Nutrition Summary</div>
                      <div style={{ fontFamily:FONT,fontSize:10,color:"#22C55E" }}>Personalised to your goals</div>
                    </div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                    <div style={{ background:"rgba(34,197,94,0.15)",borderRadius:6,padding:"2px 8px" }}>
                      <span style={{ fontFamily:FONT,fontWeight:800,fontSize:9,color:"#22C55E" }}>FREE</span>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"
                      style={{ transform:nutritionSummaryExpanded?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.3s" }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                </div>
                {nutritionSummaryExpanded && (
                  <div style={{ padding:"0 14px 14px" }}>
                    {onboardingNutritionLoading ? (
                      <div style={{ fontFamily:FONT,fontSize:13,color:"#555",textAlign:"center",padding:"12px 0" }}>Preparing your nutrition analysis…</div>
                    ) : (
                      <>
                        <div style={{ fontFamily:FONT,fontSize:13,color:"#ccc",lineHeight:1.75,borderLeft:"2px solid #22C55E44",paddingLeft:12,marginBottom:14 }}>
                          {onboardingNutritionTwText}{!onboardingNutritionTwDone && <span style={{ opacity:0.5 }}>▋</span>}
                        </div>
                        {!isPremium && (
                          <button onClick={()=>openPaymentSheet("monthly")} style={{ width:"100%",padding:"12px 0",borderRadius:50,background:"linear-gradient(135deg,#16A34A,#15803D)",border:"none",fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff",cursor:"pointer",letterSpacing:0.5,boxShadow:"0 4px 16px rgba(34,197,94,0.3)" }}>
                            Upgrade for Daily Nutrition Coaching
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* VTRX Smart Nutrition */}
            {(() => {
              const nFact = DAILY_NUTRITION_FACTS[selectedDay] || DAILY_NUTRITION_FACTS[0];
              // Find one recipe whose tags match the fact's focus tag.
              // recipeTag is absent on non-food facts (Hydration, Micronutrients) —
              // fall back to '' so .toLowerCase() never runs on undefined.
              const recipeTagLower = (nFact.recipeTag || '').toLowerCase();
              const recipeMatch = displayRecipes.find(r =>
                (r.tags||[]).some(t => t.toLowerCase().includes(recipeTagLower))
              ) || displayRecipes[0] || normalizeRecipe(RECIPES[0]);
              // Today's macros from meal plan (premium)
              const todayMacros = MEAL_SLOTS.reduce((acc, slot) => {
                const meal = getMealForDay(selectedDay, slot);
                if (meal) { acc.cal += meal.cal||0; acc.protein += meal.protein||0; acc.carbs += meal.carbs||0; acc.fat += meal.fats||0; }
                return acc;
              }, { cal:0, protein:0, carbs:0, fat:0 });
              return (
                <div style={{ background:`${PRIMARY}12`,border:`1px solid ${PRIMARY}30`,borderRadius:16,marginBottom:12,overflow:"hidden" }}>
                  {/* Header */}
                  <div onClick={()=>setBannerOpen(b=>!b)}
                    style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",cursor:"pointer" }}>
                    <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill={PRIMARY} stroke="none"><path d="M5 16l-3-9 5.5 4L12 3l4.5 8L22 7l-3 9H5zm0 2h14v2H5v-2z"/></svg>
                      <span style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff" }}>VTRX Smart Nutrition</span>
                      {!isPremium && <span style={{ background:"linear-gradient(90deg,#F59E0B,#EF4444)",borderRadius:6,padding:"2px 7px",fontFamily:FONT,fontWeight:800,fontSize:9,color:"#fff",letterSpacing:0.5 }}>PREMIUM</span>}
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"
                      style={{ transform:bannerOpen?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.3s ease" }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                  {bannerOpen && (
                    <div style={{ padding:"0 14px 14px" }}>
                      {isPremium ? (
                        /* Nutrition fact — premium only */
                        <div style={{ background:"rgba(255,255,255,0.04)",borderRadius:12,padding:"12px 12px",marginBottom:12,borderLeft:`3px solid ${PRIMARY}` }}>
                          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:12,color:PRIMARY,marginBottom:6,letterSpacing:0.3 }}>{nFact.focus}</div>
                          <div style={{ fontFamily:FONT,fontSize:12,color:"#ccc",lineHeight:1.65,marginBottom:8 }}>{nFact.fact}</div>
                          <div style={{ fontFamily:FONT,fontSize:11,color:"#888",lineHeight:1.55 }}>{nFact.examples}</div>
                        </div>
                      ) : null}
                      {isPremium ? (
                        <>
                          {/* Macro tiles — calories always derived from macros */}
                          {(()=>{
                            const macroCalories = Math.round(todayMacros.protein*4 + todayMacros.carbs*4 + todayMacros.fat*9);
                            return (
                              <div style={{ display:"flex",gap:6,marginBottom:14 }}>
                                {[
                                  {l:"Calories", v: macroCalories ?? "—", u:"kcal", c:"#FF6B35"},
                                  {l:"Protein",  v: todayMacros.protein ?? "—", u:"g", c:PRIMARY},
                                  {l:"Carbs",    v: todayMacros.carbs   ?? "—", u:"g", c:"#F59E0B"},
                                  {l:"Fat",      v: todayMacros.fat     ?? "—", u:"g", c:"#A855F7"},
                                ].map(m=>(
                                  <div key={m.l} style={{ flex:1,background:"rgba(255,255,255,0.06)",borderRadius:10,padding:"8px 4px",textAlign:"center" }}>
                                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:m.c }}>{m.v}</div>
                                    <div style={{ fontFamily:FONT,fontSize:9,color:"#888",marginTop:1 }}>{m.u}</div>
                                    <div style={{ fontFamily:FONT,fontSize:9,color:"#555",marginTop:1 }}>{m.l}</div>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                          {/* Recommended recipe — only for food-focused topics */}
                          {nFact.showRecipe ? (
                            <>
                              <div style={{ fontFamily:FONT,fontSize:11,color:"#888",marginBottom:8 }}>Try this today</div>
                              <div onClick={()=>setSelectedRecipe(recipeMatch)}
                                style={{ display:"flex",alignItems:"center",gap:12,borderRadius:14,overflow:"hidden",cursor:"pointer",background:"rgba(255,255,255,0.06)",padding:"8px" }}>
                                <div style={{ width:60,height:60,borderRadius:10,overflow:"hidden",flexShrink:0 }}>
                                  <img src={recipeMatch.img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                                </div>
                                <div style={{ flex:1 }}>
                                  <div style={{ fontFamily:FONT,fontSize:13,fontWeight:700,color:"#fff",lineHeight:1.3,marginBottom:4 }}>{recipeMatch.name}</div>
                                  <div style={{ display:"flex",gap:10,alignItems:"center" }}>
                                    <span style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>{(()=>{const p=recipeMatch.protein||0,c=recipeMatch.carbs||0,f=recipeMatch.fats||recipeMatch.fat||0;const v=Math.round(p*4+c*4+f*9);return v?`${v} cal`:recipeMatch.cal?`${recipeMatch.cal} cal`:'';})()}</span>
                                    <span style={{ fontFamily:FONT,fontSize:11,color:PRIMARY }}>{recipeMatch.protein}g protein</span>
                                    <span style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>{recipeMatch.time}</span>
                                  </div>
                                </div>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                              </div>
                            </>
                          ) : nFact.focus.includes('Hydration') ? (
                            <div style={{ background:"rgba(56,189,248,0.08)",border:"1px solid rgba(56,189,248,0.2)",borderRadius:10,padding:"10px 12px",display:"flex",alignItems:"center",gap:10 }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="#38BDF8"><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></svg>
                              <div style={{ fontFamily:FONT,fontSize:12,color:"#7DD3FC",lineHeight:1.5 }}>Aim for <strong>2.5–3.5 L</strong> of water today. Add electrolytes (sodium, potassium, magnesium) around intense sessions.</div>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {/* Blurred nutrition fact teaser */}
                          <div style={{ position:"relative",marginBottom:12 }}>
                            <div style={{ filter:"blur(5px)",pointerEvents:"none",userSelect:"none",background:"rgba(255,255,255,0.04)",borderRadius:12,padding:"12px 12px",borderLeft:`3px solid ${PRIMARY}` }}>
                              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:12,color:PRIMARY,marginBottom:6,letterSpacing:0.3 }}>{nFact.focus}</div>
                              <div style={{ fontFamily:FONT,fontSize:12,color:"#ccc",lineHeight:1.65,marginBottom:8 }}>{nFact.fact}</div>
                              <div style={{ fontFamily:FONT,fontSize:11,color:"#888",lineHeight:1.55 }}>{nFact.examples}</div>
                            </div>
                            <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",gap:8 }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:12,color:"#fff" }}>Premium only</span>
                            </div>
                          </div>
                          {/* Blurred recipe teaser — only for food-focused topics */}
                          {nFact.showRecipe && (
                            <div style={{ position:"relative",marginBottom:14 }}>
                              <div style={{ filter:"blur(5px)",pointerEvents:"none",userSelect:"none",display:"flex",alignItems:"center",gap:12,borderRadius:14,overflow:"hidden",background:"rgba(255,255,255,0.06)",padding:"8px" }}>
                                <div style={{ width:60,height:60,borderRadius:10,overflow:"hidden",flexShrink:0 }}>
                                  <img src={recipeMatch.img} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                                </div>
                                <div style={{ flex:1 }}>
                                  <div style={{ fontFamily:FONT,fontSize:13,fontWeight:700,color:"#fff",lineHeight:1.3,marginBottom:4 }}>{recipeMatch.name}</div>
                                  <div style={{ display:"flex",gap:10 }}>
                                    <span style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>{(()=>{const p=recipeMatch.protein||0,c=recipeMatch.carbs||0,f=recipeMatch.fats||recipeMatch.fat||0;const v=Math.round(p*4+c*4+f*9);return v?`${v} cal`:recipeMatch.cal?`${recipeMatch.cal} cal`:'';})()}</span>
                                    <span style={{ fontFamily:FONT,fontSize:11,color:PRIMARY }}>{recipeMatch.protein}g protein</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                          {/* CTA */}
                          <button onClick={()=>setShowUpgrade(true)}
                            style={{ width:"100%",padding:"12px 0",borderRadius:50,background:`linear-gradient(90deg,${PRIMARY},#7C3AED)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff",cursor:"pointer",letterSpacing:0.5 }}>
                            START FREE TRIAL →
                          </button>
                          <div style={{ fontFamily:FONT,fontSize:10,color:"#666",textAlign:"center",marginTop:6 }}>1 month free · No charge until trial ends · Cancel anytime</div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
            {/* Search */}
            <div style={{ position:"relative",marginBottom:12 }}>
              <svg style={{ position:"absolute",left:12,top:"50%",transform:"translateY(-50%)" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input value={search} onChange={e=>{ setSearch(e.target.value); if(e.target.value.length>0) setBannerOpen(false); }} placeholder="Search recipes..." style={{ width:"100%",background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"10px 12px 10px 36px",fontFamily:FONT,fontSize:13,color:"#fff",outline:"none",boxSizing:"border-box" }}/>
            </div>
            {/* Filters */}
            <div style={{ display:"flex",gap:8,overflowX:"auto",marginBottom:14,paddingBottom:4 }}>
              {NUTRITION_FILTERS.map(f=>(
                <button key={f} onClick={()=>handleFilterChange(f)}
                  style={{ flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${filter===f?PRIMARY:BORDER}`,background:filter===f?`${PRIMARY}18`:"transparent",fontFamily:FONT,fontWeight:600,fontSize:11,color:filter===f?PRIMARY:"#666",cursor:"pointer",transition:"all 0.2s" }}>
                  {f}
                </button>
              ))}
            </div>
            {/* Categorized sections — default Discover view (11 fixed categories, <=10 each) */}
            {showCategorizedSections && (
              <div>
                {categorizedLoading && categorized.length === 0 && (
                  <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
                    {Array.from({length:3}).map((_,s)=>(
                      <div key={s}>
                        <div style={{ height:14,width:120,background:"#1e1e1e",borderRadius:4,marginBottom:10 }}/>
                        <div style={{ display:"flex",gap:12,overflow:"hidden" }}>
                          {Array.from({length:3}).map((_,i)=>(
                            <div key={i} style={{ width:160,minWidth:160,background:CARD,borderRadius:14,overflow:"hidden",border:`1px solid ${BORDER}` }}>
                              <div style={{ height:110,background:"#1e1e1e" }}/>
                              <div style={{ padding:"10px" }}>
                                <div style={{ height:13,background:"#1e1e1e",borderRadius:4,marginBottom:6,width:"75%" }}/>
                                <div style={{ height:10,background:"#1e1e1e",borderRadius:4,width:"45%" }}/>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {!categorizedLoading && categorized.length === 0 && (
                  <div style={{ textAlign:"center",padding:"40px 16px" }}>
                    <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",marginBottom:8 }}>No recipes available yet</div>
                    <div style={{ fontFamily:FONT,fontSize:12,color:"#555",lineHeight:1.65 }}>Check back soon — new recipes are added regularly.</div>
                  </div>
                )}
                {categorized.map(cat => (
                  <div key={cat.key} style={{ marginBottom:20 }}>
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:15,color:"#fff",marginBottom:10 }}>{cat.label}</div>
                    <div style={{ display:"flex",gap:12,overflowX:"auto",paddingBottom:4,scrollbarWidth:"none",msOverflowStyle:"none" }}>
                      {cat.recipes.map((r,i) => renderCategoryTile(r,i))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Flat filtered grid — shown while searching or a specific filter pill is active */}
            {!showCategorizedSections && (
              <>
                {loadingRecipes && (
                  <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
                    {Array.from({length:10}).map((_,i)=>(
                      <div key={i} style={{ background:CARD,borderRadius:14,overflow:"hidden",border:`1px solid ${BORDER}` }}>
                        <div style={{ height:110,background:"#1e1e1e" }}/>
                        <div style={{ padding:"10px" }}>
                          <div style={{ height:13,background:"#1e1e1e",borderRadius:4,marginBottom:6,width:"75%" }}/>
                          <div style={{ height:10,background:"#1e1e1e",borderRadius:4,width:"45%" }}/>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {!loadingRecipes && filteredGrid.length===0 && (
                  <div style={{ textAlign:"center",padding:"40px 16px" }}>
                    <div style={{ width:52,height:52,borderRadius:"50%",background:`${PRIMARY}18`,border:`1px solid ${PRIMARY}33`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px" }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>
                    </div>
                    <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",marginBottom:8 }}>
                      {search ? `No results for "${search}"` : `No ${filter !== "All" ? filter.toLowerCase() : ""} recipes found`}
                    </div>
                    <div style={{ fontFamily:FONT,fontSize:12,color:"#555",lineHeight:1.65,marginBottom:20,maxWidth:260,margin:"0 auto 20px" }}>
                      {search ? "Try a different search term." : "Try a different filter or update your dietary preferences in Settings."}
                    </div>
                    {!search && (
                      <button onClick={()=>setShowProfile(true)}
                        style={{ padding:"12px 28px",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",cursor:"pointer" }}>
                        Update Preferences
                      </button>
                    )}
                  </div>
                )}
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
                  {filteredGrid.map((r,i)=>{
                    const isSaved = savedSet.has(String(r.id));
                    return (
                      <div key={r.id||i} onClick={()=>setSelectedRecipe(r)} style={{ background:"#fff",borderRadius:14,overflow:"hidden",cursor:"pointer",border:`1px solid ${BORDER}` }}>
                        <div style={{ height:110,overflow:"hidden",position:"relative" }}>
                          {r.img
                            ? <img src={r.img} alt="" width={160} height={110} loading="lazy" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                            : <div style={{ width:"100%",height:"100%",background:"linear-gradient(135deg,#1a1a2e,#16213e)",display:"flex",alignItems:"center",justifyContent:"center",padding:"8px" }}>
                                <span style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#fff",textAlign:"center",lineHeight:1.3 }}>{r.name}</span>
                              </div>
                          }
                          <button onClick={e=>{ e.stopPropagation(); toggleSave(r); }} style={{ position:"absolute",top:8,right:8,width:28,height:28,borderRadius:"50%",background:"rgba(0,0,0,0.5)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill={isSaved?"#00A3FF":"none"} stroke="#fff" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
                          </button>
                        </div>
                        <div style={{ padding:"10px" }}>
                          <div style={{ fontFamily:FONT,fontSize:12,fontWeight:700,color:"#111",marginBottom:4,lineHeight:1.3 }}>{r.name}</div>
                          <div style={{ display:"flex",gap:6 }}>
                            <span style={{ fontFamily:FONT,fontSize:10,color:"#EF4444",fontWeight:600 }}>{r.cal} cal</span>
                            <span style={{ fontFamily:FONT,fontSize:10,color:PRIMARY,fontWeight:600 }}>{r.protein}g protein</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

          </div>
        )}

        {subTab===1 && (
          <div>
            {/* Regeneration confirm modal */}
            {confirmNutriRegen && (
              <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 28px" }}>
                <div style={{ background:CARD,borderRadius:20,padding:"24px 20px",border:`1px solid ${BORDER}`,width:"100%",maxWidth:340 }}>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:"#fff",marginBottom:10 }}>Regenerate Your Plan?</div>
                  <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.65,marginBottom:20 }}>This will create a new 7-day meal plan based on your current goals and dietary preferences.</div>
                  <div style={{ display:"flex",gap:10 }}>
                    <button onClick={()=>setConfirmNutriRegen(false)} style={{ flex:1,padding:"12px",borderRadius:12,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888",cursor:"pointer" }}>Cancel</button>
                    <button onClick={generateAiNutritionPlan} style={{ flex:1,padding:"12px",borderRadius:12,background:"#16A34A",border:"none",fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",cursor:"pointer" }}>Regenerate</button>
                  </div>
                </div>
              </div>
            )}

            {/* Generating spinner */}
            {aiPlanGenerating && (
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"60px 32px",gap:20 }}>
                <div style={{ width:64,height:64,borderRadius:20,background:"#16A34A18",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="1.5"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>
                </div>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:6 }}>Building Your Nutrition Plan</div>
                  <div style={{ fontFamily:FONT,fontSize:13,color:"#666",lineHeight:1.6 }}>Your AI nutrition coach is creating a personalised 7-day plan…</div>
                </div>
              </div>
            )}

            {/* Loading */}
            {!aiPlanGenerating && aiPlanLoading && (
              <div style={{ textAlign:"center",padding:"60px 20px",color:"#555",fontFamily:FONT,fontSize:13 }}>Loading your plan…</div>
            )}

            {/* No plan yet */}
            {!aiPlanGenerating && !aiPlanLoading && !aiNutritionPlan && (
              <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 32px",gap:20 }}>
                <div style={{ width:80,height:80,borderRadius:24,background:"#16A34A18",display:"flex",alignItems:"center",justifyContent:"center" }}>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="1.4"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>
                </div>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",marginBottom:8 }}>No Nutrition Plan Yet</div>
                  <div style={{ fontFamily:FONT,fontSize:13,color:"#666",lineHeight:1.7 }}>Let your AI nutrition coach build a personalised 7-day meal plan based on your goals, dietary needs and calorie targets.</div>
                </div>
                {aiPlanError && <div style={{ fontFamily:FONT,fontSize:12,color:"#EF4444",textAlign:"center" }}>{aiPlanError}</div>}
                <button onClick={generateAiNutritionPlan} style={{ background:"#16A34A",border:"none",borderRadius:16,padding:"15px 0",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",width:"100%",maxWidth:300,boxShadow:"0 4px 24px rgba(34,197,94,0.35)" }}>
                  Generate My Nutrition Plan
                </button>
              </div>
            )}

            {/* AI Plan display */}
            {!aiPlanGenerating && !aiPlanLoading && aiNutritionPlan && (()=>{
              const dayKey  = AI_PLAN_DAYS[selectedDay] || 'monday';
              const dayData = aiNutritionPlan.week?.[dayKey] || {};
              const meals   = dayData.meals || [];
              const targets = aiNutritionPlan.daily_targets || {};
              const protTarget = targets.protein_g || currentUser?.dailyProteinTargetG || 150;
              const carbTarget = targets.carbs_g   || currentUser?.dailyCarbTargetG    || 200;
              const fatTarget  = targets.fat_g     || currentUser?.dailyFatTargetG     || 65;

              return (
                <div>
                  {/* Plan header */}
                  <div style={{ background:"linear-gradient(135deg,#0a1a0f,#0d2218)",borderRadius:16,padding:"16px",marginBottom:14,border:"1px solid #22C55E33" }}>
                    <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:"#fff",marginBottom:3 }}>{aiNutritionPlan.plan_name}</div>
                    <div style={{ fontFamily:FONT,fontSize:12,color:"#aaa",lineHeight:1.5,marginBottom:12 }}>{aiNutritionPlan.plan_summary}</div>
                    {/* Macro target chips */}
                    <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
                      {[
                        {l:"Calories",v:Math.round(calTarget),c:"#EF4444"},
                        {l:"Protein",v:`${protTarget}g`,c:PRIMARY},
                        {l:"Carbs",v:`${carbTarget}g`,c:"#F97316"},
                        {l:"Fat",v:`${fatTarget}g`,c:"#A78BFA"},
                      ].map((t,i)=>(
                        <div key={i} style={{ background:`${t.c}14`,borderRadius:10,padding:"5px 10px",border:`1px solid ${t.c}30` }}>
                          <span style={{ fontFamily:FONT,fontWeight:800,fontSize:12,color:t.c }}>{t.v}</span>
                          <span style={{ fontFamily:FONT,fontSize:10,color:"#666",marginLeft:3 }}>{t.l}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Macro tracking ring — only if tracking preference allows */}
                  {showCalTracking && (
                    <div style={{ background:CARD,borderRadius:16,padding:"16px",marginBottom:14,border:`1px solid ${BORDER}` }}>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#555",letterSpacing:1.5,marginBottom:12 }}>TODAY'S PROGRESS</div>
                      <div style={{ display:"flex",alignItems:"center",gap:16 }}>
                        {/* Calorie ring */}
                        {(()=>{
                          const pct = Math.min(1, todayConsumed.cal / calTarget);
                          const r=32,circ=2*Math.PI*r;
                          return (
                            <div style={{ position:"relative",width:80,height:80,flexShrink:0 }}>
                              <svg width={80} height={80} style={{ transform:"rotate(-90deg)" }}>
                                <circle cx={40} cy={40} r={r} fill="none" stroke="#1a1a1a" strokeWidth={6}/>
                                <circle cx={40} cy={40} r={r} fill="none" stroke="#EF4444" strokeWidth={6}
                                  strokeDasharray={circ} strokeDashoffset={circ*(1-pct)} strokeLinecap="round"/>
                              </svg>
                              <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
                                <div style={{ fontFamily:FONT,fontWeight:900,fontSize:13,color:"#fff" }}>{Math.round(todayConsumed.cal)}</div>
                                <div style={{ fontFamily:FONT,fontSize:8,color:"#666" }}>cal</div>
                              </div>
                            </div>
                          );
                        })()}
                        <div style={{ flex:1 }}>
                          {trackPref==='no_but_interested' && (
                            <div style={{ fontFamily:FONT,fontSize:11,color:"#888",marginBottom:8 }}>
                              {Math.round(todayConsumed.cal)} / {Math.round(calTarget)} calories
                              <span style={{ color:PRIMARY,marginLeft:6,cursor:"pointer" }} onClick={()=>{}}>Enable full tracking →</span>
                            </div>
                          )}
                          {showFullTracking && (
                            <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                              {[
                                {l:"Protein",v:todayConsumed.protein,t:protTarget,c:PRIMARY},
                                {l:"Carbs",  v:todayConsumed.carbs,  t:carbTarget,c:"#F97316"},
                                {l:"Fat",    v:todayConsumed.fat,    t:fatTarget,  c:"#A78BFA"},
                              ].map((m,i)=>(
                                <div key={i}>
                                  <div style={{ display:"flex",justifyContent:"space-between",marginBottom:3 }}>
                                    <span style={{ fontFamily:FONT,fontSize:10,color:"#888" }}>{m.l}</span>
                                    <span style={{ fontFamily:FONT,fontSize:10,color:m.c,fontWeight:700 }}>{Math.round(m.v)}g / {m.t}g</span>
                                  </div>
                                  <div style={{ height:5,borderRadius:3,background:"#1a1a1a",overflow:"hidden" }}>
                                    <div style={{ height:"100%",width:`${Math.min(100,m.v/m.t*100)}%`,background:m.c,borderRadius:3,transition:"width 0.4s" }}/>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Day selector */}
                  <div style={{ display:"flex",gap:6,marginBottom:14,overflowX:"auto" }}>
                    {AI_PLAN_SHORT.map((d,i)=>(
                      <div key={i} onClick={()=>{ setSelectedDay(i); setExpandedPlanMeal(null); }}
                        style={{ flexShrink:0,width:44,textAlign:"center",padding:"8px 4px",borderRadius:12,background:i===selectedDay?PRIMARY:"transparent",cursor:"pointer",transition:"background 0.2s" }}>
                        <div style={{ fontFamily:FONT,fontSize:10,fontWeight:700,color:i===selectedDay?"#fff":"#888",marginBottom:4 }}>{d}</div>
                        <div style={{ fontFamily:FONT,fontSize:12,fontWeight:800,color:i===selectedDay?"#fff":"#555" }}>
                          {aiNutritionPlan.week?.[AI_PLAN_DAYS[i]]?.day_total_calories ? `${Math.round(aiNutritionPlan.week[AI_PLAN_DAYS[i]].day_total_calories)}` : '—'}
                        </div>
                        {i===selectedDay&&<div style={{ fontFamily:FONT,fontSize:8,color:"rgba(255,255,255,0.7)" }}>cal</div>}
                      </div>
                    ))}
                  </div>

                  {/* Meal cards */}
                  {meals.length === 0 && (
                    <div style={{ textAlign:"center",padding:"30px",fontFamily:FONT,fontSize:13,color:"#555" }}>No meals for this day</div>
                  )}
                  {meals.map((meal,i)=>{
                    const mealId  = `${dayKey}-${meal.meal_name}-${meal.recipe_name}`;
                    const isLogged= loggedMeals.has(mealId);
                    const isOpen  = expandedPlanMeal === mealId;
                    return (
                      <div key={i} style={{ background:CARD,borderRadius:16,marginBottom:12,border:`1px solid ${isLogged?"#22C55E33":BORDER}`,overflow:"hidden" }}>
                        <div style={{ padding:"14px 14px 0" }}>
                          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                            <div>
                              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:9,color:"#22C55E",letterSpacing:1.5,marginBottom:2 }}>{meal.meal_name?.toUpperCase()} · {meal.meal_time_suggestion}</div>
                              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff" }}>{meal.recipe_name}</div>
                            </div>
                            {isLogged
                              ? <div style={{ background:"#22C55E18",borderRadius:20,padding:"5px 10px",border:"1px solid #22C55E44",display:"flex",alignItems:"center",gap:4 }}>
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                                  <span style={{ fontFamily:FONT,fontSize:10,fontWeight:700,color:"#22C55E" }}>Logged</span>
                                </div>
                              : <button onClick={()=>logPlanMeal(meal,dayKey)} style={{ background:"#22C55E",border:"none",borderRadius:20,padding:"6px 12px",fontFamily:FONT,fontWeight:700,fontSize:10,color:"#fff",cursor:"pointer" }}>Log</button>
                            }
                          </div>
                          <div style={{ display:"flex",gap:10,marginBottom:10 }}>
                            {meal.ymove_image_url
                              ? <img src={meal.ymove_image_url} alt="" style={{ width:72,height:72,borderRadius:12,objectFit:"cover",flexShrink:0 }}/>
                              : <div style={{ width:72,height:72,borderRadius:12,background:"#1a1a1a",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
                                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>
                                </div>
                            }
                            <div style={{ flex:1 }}>
                              <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginBottom:4 }}>
                                {[{v:meal.calories,l:"cal",c:"#EF4444"},{v:`${meal.protein_g}g`,l:"prot",c:PRIMARY},{v:`${meal.carbs_g}g`,l:"carb",c:"#F97316"},{v:`${meal.fat_g}g`,l:"fat",c:"#A78BFA"}].map((s,j)=>(
                                  <div key={j} style={{ textAlign:"center" }}>
                                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:12,color:s.c }}>{s.v}</div>
                                    <div style={{ fontFamily:FONT,fontSize:8,color:"#555" }}>{s.l}</div>
                                  </div>
                                ))}
                              </div>
                              <div style={{ fontFamily:FONT,fontSize:11,color:"#666" }}>⏱ {meal.prep_time_mins} min prep</div>
                              {meal.meal_prep_note && <div style={{ fontFamily:FONT,fontSize:10,color:"#555",marginTop:3,fontStyle:"italic" }}>{meal.meal_prep_note}</div>}
                            </div>
                          </div>
                          {/* Expand toggle */}
                          <button onClick={()=>setExpandedPlanMeal(isOpen?null:mealId)}
                            style={{ width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:"none",border:`1px solid ${BORDER}`,borderRadius:10,padding:"8px",cursor:"pointer",marginBottom:12 }}>
                            <span style={{ fontFamily:FONT,fontSize:11,color:"#666",fontWeight:600 }}>{isOpen?"Hide":"Show"} ingredients & instructions</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" style={{ transform:isOpen?"rotate(180deg)":"none",transition:"transform 0.2s" }}><polyline points="6 9 12 15 18 9"/></svg>
                          </button>
                        </div>
                        {isOpen && (
                          <div style={{ padding:"0 14px 14px",borderTop:`1px solid ${BORDER}` }}>
                            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#555",letterSpacing:1,marginBottom:8,marginTop:12 }}>INGREDIENTS</div>
                            {(meal.ingredients||[]).map((ing,j)=>(
                              <div key={j} style={{ display:"flex",gap:8,paddingBottom:6,borderBottom:j<meal.ingredients.length-1?`1px solid ${BORDER}`:"none",marginBottom:6 }}>
                                <div style={{ width:5,height:5,borderRadius:"50%",background:"#22C55E",marginTop:5,flexShrink:0 }}/>
                                <div style={{ fontFamily:FONT,fontSize:12,color:"#ccc" }}>{ing.amount} {ing.unit} {ing.item}</div>
                              </div>
                            ))}
                            {meal.instructions && (
                              <div>
                                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#555",letterSpacing:1,marginBottom:6,marginTop:12 }}>INSTRUCTIONS</div>
                                <div style={{ fontFamily:FONT,fontSize:12,color:"#bbb",lineHeight:1.65 }}>{meal.instructions}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Supplement suggestions */}
                  {aiNutritionPlan.supplement_suggestions?.length>0 && (
                    <div style={{ background:CARD,borderRadius:14,padding:"14px 16px",marginBottom:14,border:`1px solid ${BORDER}` }}>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#555",letterSpacing:1.5,marginBottom:10 }}>SUPPLEMENT SUGGESTIONS</div>
                      {aiNutritionPlan.supplement_suggestions.map((s,i)=>(
                        <div key={i} style={{ marginBottom:i<aiNutritionPlan.supplement_suggestions.length-1?10:0,paddingBottom:i<aiNutritionPlan.supplement_suggestions.length-1?10:0,borderBottom:i<aiNutritionPlan.supplement_suggestions.length-1?`1px solid ${BORDER}`:"none" }}>
                          <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",marginBottom:2 }}>{s.supplement}</div>
                          <div style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>{s.reason} · {s.timing}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Regenerate + coach message */}
                  {aiNutritionPlan.nutrition_coach_message && (
                    <div style={{ background:CARD,borderRadius:14,padding:"14px 16px",marginBottom:10,border:`1px solid ${BORDER}`,display:"flex",gap:12,alignItems:"flex-start" }}>
                      <div style={{ width:30,height:30,borderRadius:9,background:"#16A34A",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="white"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                      </div>
                      <div style={{ fontFamily:FONT,fontSize:12,color:"#bbb",lineHeight:1.6,fontStyle:"italic",flex:1 }}>"{aiNutritionPlan.nutrition_coach_message}"</div>
                    </div>
                  )}
                  <button onClick={()=>setConfirmNutriRegen(true)}
                    style={{ width:"100%",padding:"12px",borderRadius:14,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:13,color:"#555",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:6 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                    Regenerate Plan
                  </button>
                </div>
              );
            })()}
          </div>
        )}

        {subTab===2 && (
          aiNutritionPlan?.shopping_list ? (
            <div>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:"#fff",marginBottom:4 }}>Shopping List</div>
              <div style={{ fontFamily:FONT,fontSize:12,color:"#666",marginBottom:16 }}>From your AI nutrition plan · tap to check off items</div>
              {Object.entries(aiNutritionPlan.shopping_list).map(([cat,items])=>{
                if (!items?.length) return null;
                const catLabel = { proteins:"Proteins",carbs:"Carbs",vegetables:"Vegetables",healthy_fats:"Healthy Fats",pantry:"Pantry",snacks:"Snacks" }[cat] || cat;
                const catColor = { proteins:PRIMARY,carbs:"#F97316",vegetables:"#22C55E",healthy_fats:"#A78BFA",pantry:"#F59E0B",snacks:"#EC4899" }[cat] || "#888";
                return (
                  <div key={cat} style={{ background:CARD,borderRadius:14,padding:"14px 16px",marginBottom:12,border:`1px solid ${BORDER}` }}>
                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:11,color:catColor,letterSpacing:1.5,marginBottom:10 }}>{catLabel.toUpperCase()}</div>
                    {items.map((item,i)=>{
                      const key = `${cat}-${item}`;
                      const checked = aiShoppingChecked.has(key);
                      return (
                        <div key={i} onClick={()=>setAiShoppingChecked(prev=>{ const n=new Set(prev); checked?n.delete(key):n.add(key); return n; })}
                          style={{ display:"flex",alignItems:"center",gap:12,padding:"9px 0",borderBottom:i<items.length-1?`1px solid ${BORDER}`:"none",cursor:"pointer" }}>
                          <div style={{ width:20,height:20,borderRadius:6,border:`2px solid ${checked?catColor:"#333"}`,background:checked?catColor:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.15s" }}>
                            {checked&&<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                          </div>
                          <span style={{ fontFamily:FONT,fontSize:13,color:checked?"#555":"#ccc",textDecoration:checked?"line-through":"none",transition:"all 0.15s" }}>{item}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {aiNutritionPlan.meal_prep_tips?.length>0 && (
                <div style={{ background:"#081408",borderRadius:14,padding:"14px 16px",border:"1px solid #22C55E22" }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#22C55E",letterSpacing:1.5,marginBottom:10 }}>MEAL PREP TIPS</div>
                  {aiNutritionPlan.meal_prep_tips.map((tip,i)=>(
                    <div key={i} style={{ display:"flex",gap:10,marginBottom:i<aiNutritionPlan.meal_prep_tips.length-1?10:0 }}>
                      <span style={{ fontFamily:FONT,fontSize:12,color:"#22C55E",fontWeight:700 }}>{i+1}.</span>
                      <span style={{ fontFamily:FONT,fontSize:12,color:"#aaa",lineHeight:1.6 }}>{tip}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <GroceryTab checkedGrocery={checkedGrocery} setCheckedGrocery={setCheckedGrocery} groceryList={computedGroceryList}/>
          )
        )}

        {subTab===3 && (
          <div>
            {savedRecipes.length===0 ? (
              <div style={{ textAlign:"center",padding:"60px 20px",color:"#555",fontFamily:FONT,fontSize:14 }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5" style={{marginBottom:16,display:"block",margin:"0 auto 16px"}}><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
                No saved recipes yet. Tap the bookmark icon on any recipe.
              </div>
            ) : savedRecipes.map(r=>(
              <div key={r.id} onClick={()=>setSelectedRecipe(r)} style={{ background:CARD,borderRadius:14,padding:"12px",marginBottom:10,display:"flex",gap:12,alignItems:"center",border:`1px solid ${BORDER}`,cursor:"pointer" }}>
                {r.img
                  ? <img src={r.img} alt="" style={{ width:60,height:60,borderRadius:10,objectFit:"cover",flexShrink:0 }}/>
                  : <div style={{ width:60,height:60,borderRadius:10,background:"#1a1a1a",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#444" strokeWidth="1.5"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>
                    </div>
                }
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff",marginBottom:3 }}>{r.name}</div>
                  <div style={{ display:"flex",gap:8 }}>
                    <span style={{ fontFamily:FONT,fontSize:11,color:"#EF4444",fontWeight:600 }}>{r.cal} cal</span>
                    <span style={{ fontFamily:FONT,fontSize:11,color:PRIMARY,fontWeight:600 }}>{r.protein}g protein</span>
                  </div>
                </div>
                <button onClick={e=>{ e.stopPropagation(); toggleSave(r); }} style={{ width:32,height:32,borderRadius:"50%",background:"rgba(0,163,255,0.1)",border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={PRIMARY} stroke={PRIMARY} strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
                </button>
              </div>
            ))}
            {!isPremium&&savedSet.size>=3&&<div style={{ textAlign:"center",padding:"16px",fontFamily:FONT,fontSize:12,color:"#666" }}>Upgrade to Premium for unlimited saves</div>}
          </div>
        )}
      </div>
      {/* Recipe overlay — keeps NutritionHub mounted so scroll + tab are preserved */}
      {selectedRecipe !== null && (
        <div style={{ position:"absolute",inset:0,zIndex:50,animation:"slideR 0.3s ease both" }}>
          <RecipeFullPage
            r={selectedRecipe}
            isSaved={savedSet.has(String(selectedRecipe.id))}
            onToggleSave={()=>toggleSave(selectedRecipe)}
            onBack={()=>setSelectedRecipe(null)}
          />
        </div>
      )}
    </div>


  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── DASHBOARD HELPERS ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function Ring({ pct }) {
  const r=36,circ=2*Math.PI*r,offset=circ*(1-Math.min(pct,100)/100);
  return (
    <div style={{ position:"relative",width:90,height:90,flexShrink:0 }}>
      <svg width={90} height={90} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={45} cy={45} r={r} fill="none" stroke="#1f1f1f" strokeWidth={7}/>
        <circle cx={45} cy={45} r={r} fill="none" stroke={PRIMARY} strokeWidth={7}
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" style={{ transition:"stroke-dashoffset 1.2s ease" }}/>
      </svg>
      <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
        {pct === 0
          ? <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#555",letterSpacing:1 }}>START</div>
          : <>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:PRIMARY,lineHeight:1 }}>{Math.round(pct)}%</div>
              <div style={{ fontFamily:FONT,fontWeight:600,fontSize:8,color:"#888",letterSpacing:1 }}>DONE</div>
            </>
        }
      </div>
    </div>
  );
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


      {/* Freeze confirmation sheet — shows status if already frozen, else activation */}


// ── Personalise workout plan from user profile ────────────────────────────────
function getTailoredWorkout(user, energyKey) {
  const level = (user?.fitnessLevel || user?.level || "intermediate").toLowerCase();
  const goal  = (user?.goal || "build muscle").toLowerCase();
  const base  = energyKey ? WORKOUTS[energyKey] : WORKOUTS.okay;

  // Adjust workout name/target based on goal
  if (goal.includes("weight") || goal.includes("fat") || goal.includes("loss")) {
    return { ...base, type:"HIIT",     name:"Fat Burn Circuit",    target:"Full Body, Core, Cardio" };
  }
  if (goal.includes("cardio") || goal.includes("endurance") || goal.includes("run")) {
    return { ...base, type:"CARDIO",   name:"Endurance Run",       target:"Cardiovascular System, Legs" };
  }
  if (goal.includes("mobility") || goal.includes("flex")) {
    return { ...base, type:"MOBILITY", name:"Mobility Flow",        target:"Joints, Hip Flexors, Hamstrings" };
  }
  // Default: strength/muscle — adjust by level
  if (level === "beginner") {
    return { ...base, name:"Beginner Strength", target:"Full Body, Foundation Movements", mins:25, cal:200, exercises:5 };
  }
  if (level === "advanced" || level === "hardcore") {
    return { ...base, name:"Advanced Power",    target:"All Major Muscle Groups",         mins:60, cal:480, exercises:10 };
  }
  return base;
}

// ── Tailor meal plan based on user goal ───────────────────────────────────────
function getTailoredMealOptions(user) {
  const goal = (user?.goal || "").toLowerCase();
  if (goal.includes("weight") || goal.includes("fat") || goal.includes("loss")) {
    return {
      breakfast: MEAL_OPTIONS.breakfast.filter((_,i)=>i!==0), // skip highest cal
      lunch:     MEAL_OPTIONS.lunch,
      snack:     MEAL_OPTIONS.snack,
      dinner:    MEAL_OPTIONS.dinner.filter((_,i)=>i!==3),    // skip beef
    };
  }
  if (goal.includes("muscle") || goal.includes("bulk") || goal.includes("gain")) {
    return MEAL_OPTIONS; // all options fine for muscle gain
  }
  return MEAL_OPTIONS;
}


// ─────────────────────────────────────────────────────────────────────────────
// ── Nutrition Plan Regen Page (shown from ProfilePage subPage) ───────────────
function NutriRegenPage({ onBack, onNavigate }) {
  const [generating, setGenerating] = useState(false);
  const [done,       setDone]       = useState(false);
  const [error,      setError]      = useState(null);

  const go = async () => {
    setGenerating(true); setError(null);
    try {
      await apiCall('/nutrition/generate-plan', { method:'POST' });
      setDone(true);
    } catch(_) { setError('Generation failed — please try again.'); setGenerating(false); }
  };

  return (
    <div style={{ position:"absolute",inset:0,zIndex:60,background:"rgba(0,0,0,0.9)",display:"flex",alignItems:"center",justifyContent:"center",padding:"0 28px",animation:"fadeIn 0.2s ease" }}>
      <div style={{ background:CARD,borderRadius:22,padding:"28px 22px",border:`1px solid ${BORDER}`,width:"100%",maxWidth:340 }}>
        {done ? (
          <>
            <div style={{ width:56,height:56,borderRadius:16,background:"#16A34A18",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px" }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff",textAlign:"center",marginBottom:8 }}>Plan Ready!</div>
            <div style={{ fontFamily:FONT,fontSize:13,color:"#888",textAlign:"center",lineHeight:1.6,marginBottom:22 }}>Your new 7-day nutrition plan has been generated.</div>
            <button onClick={onBack} style={{ width:"100%",padding:"13px",borderRadius:12,background:"#16A34A",border:"none",fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",cursor:"pointer" }}>Done</button>
          </>
        ) : (
          <>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:"#fff",marginBottom:10 }}>Regenerate Nutrition Plan?</div>
            <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.65,marginBottom:20 }}>This will create a new personalised 7-day meal plan based on your current goals and dietary preferences.</div>
            {error && <div style={{ fontFamily:FONT,fontSize:12,color:"#EF4444",marginBottom:12,textAlign:"center" }}>{error}</div>}
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={onBack} style={{ flex:1,padding:"13px",borderRadius:12,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888",cursor:"pointer" }}>Cancel</button>
              <button onClick={go} disabled={generating}
                style={{ flex:1,padding:"13px",borderRadius:12,background:"#16A34A",border:"none",fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",cursor:"pointer",opacity:generating?0.7:1 }}>
                {generating ? "Generating…" : "Regenerate"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// MY PLAN PAGE — AI-generated 4-week personalised workout programme
// ─────────────────────────────────────────────────────────────────────────────
function MyPlanPage({ onBack, onNavigate }) {
  const [plan,            setPlan]            = useState(null);
  const [weekNumber,      setWeekNumber]      = useState(1);
  const [selectedSession, setSelectedSession] = useState(null);
  const [loading,         setLoading]         = useState(true);
  const [generating,      setGenerating]      = useState(false);
  const [error,           setError]           = useState(null);
  const [confirmRegen,    setConfirmRegen]     = useState(false);
  const [exVideos,        setExVideos]         = useState({});
  const [expandedEx,      setExpandedEx]       = useState(null);

  useEffect(() => { loadPlan(); }, []);

  const applyPlan = (data) => {
    setPlan(data.plan);
    const wk   = data.weekNumber || 1;
    setWeekNumber(wk);
    const week = data.plan?.weeks?.[wk - 1];
    setSelectedSession(week?.sessions?.find(s => !s.isRestDay) || null);
    setExpandedEx(null);
  };

  const loadPlan = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiCall('/workouts/active-plan');
      if (res?.data?.plan) {
        if (!Array.isArray(res.data.plan.weeks) || res.data.plan.weeks.length === 0) {
          setPlan(null); // treat malformed plan as no plan
        } else {
          applyPlan(res.data);
        }
      }
    } catch(err) {
      const status = err?.status || err?.response?.status;
      if (status === 401) {
        // Session expired — apiCall already handles this globally, just clear state
        setError(null);
      } else if (status === 404) {
        // No plan exists — show the generate plan CTA, not an error
        setPlan(null);
        setError(null);
      } else {
        setError('Could not load your plan. Check your connection and try again.');
      }
    }
    setLoading(false);
  };

  const generatePlan = async () => {
    setGenerating(true); setError(null); setConfirmRegen(false);
    try {
      const res = await apiCall('/workouts/generate-plan', { method: 'POST' });
      if (res?.data?.plan) applyPlan(res.data);
    } catch(_) { setError('Generation failed — please try again.'); }
    setGenerating(false);
  };

  const fetchExVideo = async (term) => {
    if (!term || exVideos[term] !== undefined) return;
    setExVideos(p => ({ ...p, [term]: null }));
    try {
      const res = await apiCall(`/workouts/exercise-video?name=${encodeURIComponent(term)}`);
      if (res?.data?.videoUrl) setExVideos(p => ({ ...p, [term]: res.data.videoUrl }));
    } catch(_) {}
  };

  const currentWeek = plan?.weeks?.[weekNumber - 1];
  const sessions    = (currentWeek?.sessions || []).filter(s => !s.isRestDay);

  if (generating) return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:24,padding:"0 32px" }}>
      <div style={{ width:80,height:80,borderRadius:24,background:`${PRIMARY}14`,display:"flex",alignItems:"center",justifyContent:"center" }}>
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </div>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontFamily:FONT,fontWeight:900,fontSize:19,color:"#fff",marginBottom:8 }}>Building Your Plan</div>
        <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.7 }}>Designing your personalised 4-week programme based on your goals, equipment and experience level…</div>
      </div>
    </div>
  );

  if (loading) return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",alignItems:"center",justifyContent:"center" }}>
      <div style={{ fontFamily:FONT,fontSize:13,color:"#555" }}>Loading your plan…</div>
    </div>
  );

  if (!plan) return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <BackHeader title="MY PLAN" onBack={onBack}/>
      <div style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 32px",gap:22 }}>
        <div style={{ width:90,height:90,borderRadius:24,background:`${PRIMARY}12`,display:"flex",alignItems:"center",justifyContent:"center" }}>
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.4"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </div>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:21,color:"#fff",marginBottom:8 }}>No Plan Yet</div>
          <div style={{ fontFamily:FONT,fontSize:13,color:"#666",lineHeight:1.7 }}>Generate a personalised 4-week programme based on your goals, experience and available equipment.</div>
        </div>
        {error && <div style={{ fontFamily:FONT,fontSize:12,color:"#EF4444",textAlign:"center" }}>{error}</div>}
        <button onClick={generatePlan}
          style={{ background:PRIMARY,border:"none",borderRadius:16,padding:"15px 0",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",width:"100%",maxWidth:300,boxShadow:`0 4px 24px ${PRIMARY}44` }}>
          Generate My Plan
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <BackHeader title="MY PLAN" onBack={onBack}
        right={
          <button onClick={()=>setConfirmRegen(true)}
            style={{ width:36,height:36,borderRadius:10,background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          </button>
        }/>

      {confirmRegen && (
        <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.8)",zIndex:90,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 28px" }}>
          <div style={{ background:CARD,borderRadius:20,padding:"24px 20px",border:`1px solid ${BORDER}`,width:"100%",maxWidth:340 }}>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:16,color:"#fff",marginBottom:10 }}>Regenerate Your Plan?</div>
            <div style={{ fontFamily:FONT,fontSize:13,color:"#888",lineHeight:1.65,marginBottom:20 }}>This will create a new 4-week programme based on your current goals. Your workout history is kept.</div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>setConfirmRegen(false)} style={{ flex:1,padding:"12px",borderRadius:12,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:700,fontSize:13,color:"#888",cursor:"pointer" }}>Cancel</button>
              <button onClick={generatePlan} style={{ flex:1,padding:"12px",borderRadius:12,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",cursor:"pointer" }}>Regenerate</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex:1,overflowY:"auto",paddingBottom:100 }}>

        {/* ── Plan header ────────────────────────────────────────────────── */}
        <div style={{ background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,margin:"0 14px 14px",borderRadius:18,padding:"20px 18px" }}>
          <div style={{ fontFamily:FONT,fontWeight:900,fontSize:18,color:"#fff",marginBottom:4 }}>{plan.planName}</div>
          <div style={{ fontFamily:FONT,fontSize:12,color:"rgba(255,255,255,0.82)",lineHeight:1.55,marginBottom:14 }}>
            {plan.frequency || 3} sessions/week · 4 weeks · {plan.level || 'beginner'} level
          </div>
          <div style={{ display:"flex",gap:6 }}>
            {[1,2,3,4].map(w=>(
              <button key={w} onClick={()=>{
                const wk = plan?.weeks?.[w - 1];
                setWeekNumber(w);
                setSelectedSession(wk?.sessions?.find(s => !s.isRestDay) || null);
                setExpandedEx(null);
              }} style={{ flex:1,padding:"7px 0",borderRadius:10,border:`2px solid rgba(255,255,255,${w===weekNumber?0.9:0.25})`,background:w===weekNumber?"rgba(255,255,255,0.2)":"transparent",fontFamily:FONT,fontWeight:800,fontSize:12,color:w===weekNumber?"#fff":"rgba(255,255,255,0.55)",cursor:"pointer",transition:"all 0.2s" }}>
                Wk {w}
              </button>
            ))}
          </div>
        </div>

        {/* ── Session selector ──────────────────────────────────────────── */}
        <div style={{ padding:"0 14px 14px" }}>
          <div style={{ fontFamily:FONT,fontWeight:800,fontSize:11,color:"#555",letterSpacing:1.5,marginBottom:10 }}>THIS WEEK'S SESSIONS</div>
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {sessions.map((sess,i)=>{
              const sel = selectedSession?.dayOfWeek===sess.dayOfWeek && selectedSession?.sessionName===sess.sessionName;
              const sessLabel = (sess.sessionName || '').replace(/ — Week \d+$/, '');
              return (
                <button key={i} onClick={()=>{ setSelectedSession(sess); setExpandedEx(null); }}
                  style={{ width:"100%",padding:"13px 15px",borderRadius:14,background:sel?`${PRIMARY}14`:CARD,border:`1.5px solid ${sel?PRIMARY:BORDER}`,display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",transition:"all 0.18s" }}>
                  <div style={{ width:38,height:38,borderRadius:10,background:sel?PRIMARY:CARD2,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background 0.18s" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={sel?"#fff":"#555"} strokeWidth="1.8"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:sel?PRIMARY:"#fff",marginBottom:2 }}>{sess.dayOfWeek}</div>
                    <div style={{ fontFamily:FONT,fontSize:11,color:"#555" }}>{sessLabel} · {sess.durationMins}min · {sess.exercises?.length||0} exercises</div>
                  </div>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={sel?PRIMARY:"#444"} strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Session detail ────────────────────────────────────────────── */}
        {selectedSession && (
          <div style={{ padding:"0 14px" }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:11,color:"#555",letterSpacing:1.5,marginBottom:10 }}>SESSION DETAIL</div>

            {(selectedSession.exercises||[]).map((ex,i)=>{
              const normEx      = normaliseExercise({ ...ex, muscles: ex.muscleGroup, restSecs: ex.restSeconds });
              const isEx        = expandedEx===i;
              const vUrl        = exVideos[ex.name];
              const repsDisplay = ex.isTimedExercise ? `${ex.durationSecs ?? 30}s` : `${normEx.reps ?? '—'} reps`;
              const repsLabel   = ex.isTimedExercise ? 'TIME' : 'REPS';
              const repsValue   = ex.isTimedExercise ? `${ex.durationSecs ?? 30}s` : (normEx.reps ?? '—');
              const muscle      = (normEx.muscles||'').split('_').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
              return (
                <div key={i} style={{ background:CARD,borderRadius:14,marginBottom:8,border:`1.5px solid ${isEx?PRIMARY:BORDER}`,overflow:"hidden",transition:"border-color 0.18s" }}>
                  <div onClick={()=>{ const next=isEx?null:i; setExpandedEx(next); if(next!==null) fetchExVideo(ex.name); }}
                    style={{ padding:"13px 15px",display:"flex",alignItems:"center",gap:12,cursor:"pointer" }}>
                    <div style={{ width:36,height:36,borderRadius:10,background:`${PRIMARY}14`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                      <span style={{ fontFamily:FONT,fontWeight:900,fontSize:13,color:PRIMARY }}>{i+1}</span>
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:"#fff",marginBottom:2 }}>{ex.name}</div>
                      <div style={{ fontFamily:FONT,fontSize:11,color:"#555" }}>{normEx.sets} sets × {repsDisplay} · {normEx.restSecs}s rest</div>
                    </div>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={isEx?PRIMARY:"#444"} strokeWidth="2"
                      style={{ transform:isEx?"rotate(90deg)":"rotate(0)",transition:"transform 0.18s" }}>
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </div>
                  {isEx&&(
                    <div style={{ padding:"0 15px 14px",borderTop:`1px solid ${BORDER}` }}>
                      <div style={{ display:"flex",gap:7,marginTop:12,marginBottom:12 }}>
                        {[{l:"SETS",v:normEx.sets},{l:repsLabel,v:repsValue},{l:"REST",v:`${normEx.restSecs}s`},{l:"MUSCLE",v:muscle}].map(s=>(
                          <div key={s.l} style={{ flex:1,background:CARD2,borderRadius:10,padding:"8px 4px",textAlign:"center" }}>
                            <div style={{ fontFamily:FONT,fontSize:9,color:"#444",letterSpacing:1.2,marginBottom:3 }}>{s.l}</div>
                            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:13,color:PRIMARY }}>{s.v}</div>
                          </div>
                        ))}
                      </div>
                      {vUrl&&(
                        <div style={{ borderRadius:12,overflow:"hidden",marginTop:4 }}>
                          <video src={vUrl} controls playsInline style={{ width:"100%",maxHeight:190,objectFit:"cover",borderRadius:12 }}/>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <button onClick={()=>{
              const workoutObj = {
                id: null,
                name: selectedSession.sessionName,
                type: selectedSession.type || 'STRENGTH',
                duration: selectedSession.durationMins,
                calories: selectedSession.calories,
                exercises: (selectedSession.exercises || []).map(ex => normaliseExercise({
                  ...ex,
                  muscles: ex.muscleGroup,
                  restSecs: ex.restSeconds,
                })),
              };
              onNavigate("workoutDetail", workoutObj);
            }} style={{ width:"100%",padding:"15px",borderRadius:16,background:PRIMARY,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",cursor:"pointer",letterSpacing:0.3,boxShadow:`0 4px 20px ${PRIMARY}40`,marginBottom:14 }}>
              Start Session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Dashboard({ userProfile, onNavigate, scrollRef, mealIdx=0, setMealIdx, streakDay=1, energyKey, onMoodSelect, weeklyWorkoutDays=0, weeklyAvgCal=null, weeklyAvgMin=null, apiWorkout=null, notifCount=0, onNotifReset, onLogout }) {
  const { dark } = useTheme();
  const { user, profileImg, isPremium } = useUser();
  const [trialEndedDismissed, setTrialEndedDismissed] = useState(false);
  const subStatus = user?.subscription?.status;
  const showTrialBanner = !isPremium && !trialEndedDismissed &&
    (subStatus === 'expired' || subStatus === 'cancelled');
  const [showSwap, setShowSwap]   = useState(false);
  const [showMood, setShowMood]   = useState(false);
  const [showNotifs, setShowNotifs]   = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const hasUnread = notifCount > 0;
  const [workoutDone,      setWorkoutDone]      = useState(false);
  const [freezeUsed,  setFreezeUsed]  = useState(()=>{
    try {
      const saved = JSON.parse(localStorage.getItem("vtrx_freeze")||"{}");
      return saved.date === new Date().toLocaleDateString('en-CA') ? saved.used : false;
    } catch(_e){ return false; }
  });
  const [showFreezeSheet, setShowFreezeSheet] = useState(false);

  // Check for newly earned achievements (notification badging handled by notifCount from API)
  useEffect(()=>{
    const stats = {
      streakDays: streakDay, workoutsTotal: 0, earlyWorkouts:0,
      mealStreakDays:0, savedRecipes:0, challengesJoined:0,
      challengesDone:0, profileComplete:!!(user?.name), freezeUsed:false,
    };
    try {
      const seen = JSON.parse(localStorage.getItem("vtrx_seen_achievements")||"[]");
      const earned = ACHIEVEMENTS.filter(a=>getProgress(a.req,stats)>=a.req.n);
      const newOnes = earned.filter(a=>!seen.includes(a.id));
      // Could surface achievement unlocks here in future
    } catch(_e){}
  }, [streakDay]);
  const freezesAvailable = isPremium ? (freezeUsed ? 0 : 1) : 0;

  const activateFreeze = () => {
    setFreezeUsed(true);
    try { localStorage.setItem("vtrx_freeze", JSON.stringify({ used:true, date:new Date().toLocaleDateString('en-CA') })); } catch(_e){}
    setShowFreezeSheet(false);
  };

  const daysPerWeek = (userProfile && userProfile.daysPerWeek) || 5;
  const workoutDays = weeklyWorkoutDays;
  const dayOfYear   = Math.floor((new Date() - new Date(new Date().getFullYear(),0,0)) / 86400000);
  const quote       = QUOTES[dayOfYear % QUOTES.length];
  // Filter MEALS by dietary restrictions and goal
  const userRestrictions = user?.dietaryRestrictions || [];
  const userNutritionGoal = user?.nutritionGoal || '';
  const eligibleMeals = MEALS.filter(m => {
    const name = (m.name || m.title || '').toLowerCase();
    const ingredients = (m.ingredients || []).join(' ').toLowerCase();
    const text = name + ' ' + ingredients;
    if (userRestrictions.includes('vegan') && /chicken|beef|pork|fish|egg|dairy|milk|cheese/i.test(text)) return false;
    if (userRestrictions.includes('vegetarian') && /chicken|beef|pork|fish/i.test(text)) return false;
    return true;
  }).sort((a,b) => {
    // Sort by goal alignment: build_muscle → high protein first, lose_fat → low cal first
    if (userNutritionGoal === 'build_muscle') return (b.protein||0) - (a.protein||0);
    if (userNutritionGoal === 'lose_fat') return (a.cal||a.calories||999) - (b.cal||b.calories||999);
    return 0;
  });
  const mealPool = eligibleMeals.length > 0 ? eligibleMeals : MEALS;
  const meal        = mealPool[mealIdx % mealPool.length];
  const altMeals    = mealPool.filter((_,i) => i !== (mealIdx % mealPool.length)).slice(0,2);
  const workout     = apiWorkout || getTailoredWorkout(user, energyKey);
  const lvl         = energyKey ? ENERGY_LEVELS.find(l => l.key === energyKey) : null;
  const pct         = (workoutDays / daysPerWeek) * 100;
  const hr          = new Date().getHours();
  const greeting    = hr < 12 ? "Good Morning" : hr < 17 ? "Good Afternoon" : "Good Evening";
  const _rawDisplay = (user?.name || user?.username || "").split(" ")[0];
  const displayName = _rawDisplay ? _rawDisplay.charAt(0).toUpperCase() + _rawDisplay.slice(1) : "Athlete";

  // Workout-type banner images for the card header
  const WORKOUT_BANNERS = {
    STRENGTH: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=300&q=70",
    CARDIO:   "https://images.unsplash.com/photo-1538805060514-97d9cc17730c?w=300&q=70",
    HIIT:     "https://images.unsplash.com/photo-1549060279-7e168fcee0c2?w=300&q=70",
    MOBILITY: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=300&q=70",
    RECOVERY: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=300&q=70",
    REST:     "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=300&q=70",
  };
  const workoutBanner = WORKOUT_BANNERS[workout.type] || WORKOUT_BANNERS.STRENGTH;
  // Exercise list for preview — use API exercises, fall back to today's WEEKLY_WORKOUTS entry
  const exList = Array.isArray(apiWorkout?.exercises) && apiWorkout.exercises.length > 0
    ? apiWorkout.exercises
    : (WEEKLY_WORKOUTS[TODAY_IDX % WEEKLY_WORKOUTS.length]?.exercises || []);
  const exPreview = exList.slice(0, 4);

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column" }}>
      <MoodSheet visible={!energyKey||showMood} onSelect={(k)=>{ onMoodSelect&&onMoodSelect(k); setShowMood(false); }}/>

      {showNotifs&&(
        <div style={{ position:"absolute",inset:0,zIndex:80,animation:"slideR 0.36s ease both" }}>
          <NotificationsPage onBack={()=>setShowNotifs(false)} onMarkAllRead={onNotifReset}/>
        </div>
      )}
      {showProfile&&(
        <div style={{ position:"absolute",inset:0,zIndex:80,animation:"slideR 0.36s ease both" }}>
          <ProfilePage onBack={()=>setShowProfile(false)} onLogout={()=>{ setShowProfile(false); onLogout&&onLogout(); }}/>
        </div>
      )}

      {/* TOP BAR */}
      <div style={{ padding:"50px 18px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <VTRXLogo size={22}/>
          <div>
            <div style={{ fontFamily:FONT,fontWeight:900,fontSize:17,color:PRIMARY,letterSpacing:3 }}>VTRX</div>
            <div style={{ fontFamily:FONT,fontWeight:500,fontSize:9.5,color:"#666",letterSpacing:0.3,marginTop:-1 }}>{greeting}, {displayName}</div>
          </div>
        </div>
        <div style={{ display:"flex",gap:9 }}>
          <button onClick={()=>setShowNotifs(true)} style={{ width:38,height:38,borderRadius:"50%",background:hasUnread?PRIMARY:CARD,border:`1px solid ${hasUnread?PRIMARY:BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",position:"relative",transition:"all 0.25s" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={hasUnread?"#fff":"#888"} strokeWidth="1.8">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 01-3.46 0"/>
            </svg>
            {hasUnread&&<div style={{ position:"absolute",top:4,right:4,width:8,height:8,borderRadius:"50%",background:"#fff",border:`1.5px solid ${PRIMARY}` }}/>}
          </button>
          <button onClick={()=>setShowFreezeSheet(p=>!p)} style={{ width:38,height:38,borderRadius:"50%",background:freezeUsed?"#0a1f0a":showFreezeSheet?PRIMARY+"22":CARD,border:"1px solid "+(freezeUsed?"#22C55E55":showFreezeSheet?PRIMARY:BORDER),display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"all 0.25s" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={freezeUsed?"#22C55E":showFreezeSheet?PRIMARY:"#888"} strokeWidth="1.8">
              <line x1="12" y1="2" x2="12" y2="22"/>
              <path d="M17 7l-5-5-5 5"/>
              <path d="M17 17l-5 5-5-5"/>
              <line x1="2" y1="12" x2="22" y2="12"/>
              <path d="M7 7l-5 5 5 5"/>
              <path d="M17 7l5 5-5 5"/>
            </svg>
          </button>
          <button onClick={()=>setShowProfile(true)} style={{ width:38,height:38,borderRadius:"50%",background:CARD,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </button>
        </div>
      </div>

      {/* SCROLL BODY */}
      <div ref={scrollRef} style={{ flex:1,overflowY:"auto",padding:"0 14px 90px",background:BG }}>
        {showTrialBanner && <TrialEndedBanner onUpgrade={()=>{ setTrialEndedDismissed(true); onNavigate("upgrade"); }}/>}

        {lvl&&<button onClick={()=>setShowMood(true)} style={{ width:"100%",padding:"9px 16px",borderRadius:50,background:lvl.bg,border:`1px solid ${lvl.color}44`,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",marginBottom:13 }}>
          <div style={{ display:"flex",alignItems:"center",gap:9 }}>
            <EnergyFaceIcon type={lvl.faceType} size={20} color={lvl.color}/>
            <span style={{ fontFamily:FONT,fontWeight:600,fontSize:12.5,color:lvl.color }}>Today: {lvl.label}</span>
          </div>
          <span style={{ fontFamily:FONT,fontSize:11,color:lvl.color,opacity:0.6 }}>Tap to change ›</span>
        </button>}

        {/* MOTIVATIONAL QUOTE */}
        <div style={{ background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,borderRadius:18,padding:"16px 18px",marginBottom:13,animation:"fadeUp 0.4s ease 0.05s both" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
            <div style={{ width:26,height:26,borderRadius:8,background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center" }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
            </div>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"rgba(255,255,255,0.85)",letterSpacing:2 }}>QUOTE OF THE DAY</div>
          </div>
          <div style={{ fontFamily:FONT,fontWeight:600,fontSize:13.5,color:"#fff",lineHeight:1.6,marginBottom:7 }}>"{quote.text}"</div>
          <div style={{ fontFamily:FONT,fontSize:11.5,color:"rgba(255,255,255,0.72)" }}>— {quote.author}</div>
        </div>

        {/* AI SUMMARY CARD */}
        <div onClick={()=>onNavigate("aiSummary")} style={{ background:"linear-gradient(135deg,#0a0f1e,#141b35)",borderRadius:18,border:`1.5px solid ${PRIMARY}33`,padding:"14px 18px",marginBottom:13,animation:"fadeUp 0.5s ease 0.08s both",cursor:"pointer",display:"flex",alignItems:"center",gap:14 }}>
          <div style={{ width:42,height:42,borderRadius:12,background:"linear-gradient(135deg,#6D28D9,#4C1D95)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 0 14px rgba(109,40,217,0.45)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#8B5CF6",letterSpacing:2,marginBottom:2 }}>AI POWERED SUMMARY</div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff" }}>VTRXAI Analysis</div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:4 }}>
            <span style={{ fontFamily:FONT,fontSize:11,color:PRIMARY,fontWeight:700 }}>View report</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </div>

        {/* MY PLAN CARD — removed AI Nutrition Coach and AI Personal Trainer quick-links (now surfaced in their own tabs) */}
        <div onClick={()=>onNavigate("myPlan")} style={{ background:"linear-gradient(135deg,#0a1a0f,#0d2218)",borderRadius:18,border:`1.5px solid #22C55E33`,padding:"14px 18px",marginBottom:13,animation:"fadeUp 0.5s ease 0.085s both",cursor:"pointer",display:"flex",alignItems:"center",gap:14 }}>
          <div style={{ width:42,height:42,borderRadius:12,background:"linear-gradient(135deg,#16A34A,#15803D)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 0 14px rgba(34,197,94,0.4)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:10,color:"#22C55E",letterSpacing:2,marginBottom:2 }}>MY WORKOUT PLAN</div>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff" }}>My 4-Week Plan</div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:4 }}>
            <span style={{ fontFamily:FONT,fontSize:11,color:"#22C55E",fontWeight:700 }}>View plan</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </div>

        {/* WEEKLY STATS */}
        <div onClick={()=>onNavigate("fitnessStats")} style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:13,animation:"fadeUp 0.4s ease 0.1s both",cursor:"pointer" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff" }}>Weekly Stats</div>
            {workoutDays === 0
                  ? <svg width="19" height="4" viewBox="0 0 19 4" fill="none" stroke="#555" strokeWidth="2.5"><line x1="0" y1="2" x2="19" y2="2"/></svg>
                  : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#FF6B35" strokeWidth="2.5"><polyline points="22 7 13.5 15.5 8.5 10.5 1 18"/><polyline points="15 7 22 7 22 14"/></svg>
                }
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:14 }}>
            <Ring pct={pct}/>
            <div style={{ display:"flex",flex:1,justifyContent:"space-around",alignItems:"center" }}>
              {[
                {v:`${workoutDays}/${daysPerWeek}`,l:"Workout Days",c:"#FF6B35"},
                {v:weeklyAvgCal!==null?weeklyAvgCal:"—",l:"Avg Calories",c:"#EF4444"},
                {v:weeklyAvgMin!==null?weeklyAvgMin:"—",l:"Avg Minutes",c:"#22C55E"},
              ].map((s,i)=>(
                <div key={i} style={{ textAlign:"center" }}>
                  <div style={{ fontFamily:FONT,fontWeight:900,fontSize:28,color:s.c,lineHeight:1 }}>{s.v}</div>
                  <div style={{ fontFamily:FONT,fontWeight:600,fontSize:9,color:"#aaa",letterSpacing:1.2,marginTop:4,textTransform:"uppercase" }}>{s.l}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* MEAL OF THE DAY */}
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:13,animation:"fadeUp 0.4s ease 0.15s both" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:13 }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff" }}>Meal of the Day</div>
            <button onClick={e=>{e.stopPropagation();onNavigate("nutrition");}} style={{ background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",width:34,height:34,borderRadius:"50%",backgroundColor:`${PRIMARY}18` }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><line x1="7" y1="2" x2="7" y2="11"/><path d="M21 15V2a5 5 0 00-5 5v6c0 .55.45 1 1 1h3c.55 0 1-.45 1-1z"/></svg>
            </button>
          </div>
          <div onClick={()=>onNavigate("nutrition")} style={{ display:"flex",gap:13,cursor:"pointer" }}>
            <img src={meal.img} alt="" style={{ width:96,height:96,borderRadius:14,objectFit:"cover",flexShrink:0 }}/>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14.5,color:"#fff",marginBottom:4,lineHeight:1.3 }}>{meal.name}</div>
              <div style={{ fontFamily:FONT,fontSize:11.5,color:"#aaa",lineHeight:1.55,marginBottom:9 }}>{meal.desc}</div>
              <div style={{ display:"flex",gap:12 }}>
                {[{v:meal.cal,l:"CALORIES",c:"#FF6B35"},{v:`${meal.protein}g`,l:"PROTEIN",c:"#EF4444"},{v:`${meal.carbs}g`,l:"CARBS",c:"#22C55E"},{v:`${meal.fats}g`,l:"FATS",c:"#22C55E"}].map(s=>(
                  <div key={s.l} style={{ textAlign:"center" }}>
                    <div style={{ fontFamily:FONT,fontWeight:800,fontSize:14,color:s.c }}>{s.v}</div>
                    <div style={{ fontFamily:FONT,fontSize:8.5,color:"#888",letterSpacing:0.8 }}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {showSwap&&(
            <div style={{ marginTop:12,borderTop:`1px solid ${BORDER}`,paddingTop:12,animation:"fadeUp 0.25s ease both" }}>
              <div style={{ fontFamily:FONT,fontWeight:700,fontSize:11,color:"#888",letterSpacing:1,marginBottom:10 }}>PICK AN ALTERNATIVE</div>
              <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
                {altMeals.map((m,i)=>(
                  <button key={i} onClick={()=>{ setMealIdx(MEALS.indexOf(m)); setShowSwap(false); }} style={{ display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:14,background:"#1e1e1e",border:`1px solid ${BORDER}`,cursor:"pointer",textAlign:"left" }}>
                    <img src={m.img} alt="" style={{ width:48,height:48,borderRadius:10,objectFit:"cover",flexShrink:0 }}/>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff" }}>{m.name}</div>
                      <div style={{ fontFamily:FONT,fontSize:11,color:"#888",marginTop:2 }}>{m.cal} cal · {m.protein}g protein</div>
                    </div>
                  </button>
                ))}
                <button onClick={()=>setShowSwap(false)} style={{ padding:"9px 0",borderRadius:12,background:"transparent",border:"none",fontFamily:FONT,fontSize:12,color:"#888",cursor:"pointer" }}>Cancel</button>
              </div>
            </div>
          )}
          {!showSwap&&<button onClick={()=>setShowSwap(true)} style={{ width:"100%",marginTop:10,padding:"9px 0",borderRadius:12,background:"transparent",border:`1px dashed ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:12,color:"#888",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.67"/></svg>
            Not feeling this? Swap meal
          </button>}
        </div>

        {/* TODAY'S WORKOUT */}
        {apiWorkout?.isRestDay ? (
          <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:13,animation:"fadeUp 0.4s ease 0.2s both",textAlign:"center" }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff",marginBottom:12 }}>Today's Workout</div>
            <div style={{ padding:"16px",background:"#1A1A2E",borderRadius:12,textAlign:"center" }}>
              <span style={{ fontSize:32 }}>😴</span>
              <p style={{ color:"#FFFFFF",fontWeight:600,marginTop:8,marginBottom:4,fontFamily:FONT }}>Today is your rest day</p>
              <p style={{ color:"#888888",fontSize:13,marginBottom:0,fontFamily:FONT }}>Recovery is part of the plan</p>
            </div>
          </div>
        ) : (
        <div style={{ background:CARD,borderRadius:20,border:`1px solid ${BORDER}`,padding:"16px 18px",marginBottom:13,animation:"fadeUp 0.4s ease 0.2s both" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
            <div style={{ fontFamily:FONT,fontWeight:800,fontSize:16,color:"#fff" }}>Today's Workout</div>
            <div style={{ background:lvl?lvl.bg:`${PRIMARY}18`,border:`1px solid ${lvl?lvl.color:PRIMARY}55`,borderRadius:20,padding:"4px 13px" }}>
              <span style={{ fontFamily:FONT,fontWeight:700,fontSize:10.5,color:lvl?lvl.color:PRIMARY,letterSpacing:1 }}>{workout.type}</span>
            </div>
          </div>
          <div style={{ display:"flex",gap:13,marginBottom:15 }}>
            <div style={{ width:88,height:88,borderRadius:14,overflow:"hidden",flexShrink:0 }}>
              <img src={workoutBanner} alt="" style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontFamily:FONT,fontWeight:800,fontSize:17,color:"#fff",marginBottom:3 }}>{generateWorkoutTitle(apiWorkout?.exercises || workout.exercises) || workout.name}</div>
              <div style={{ fontFamily:FONT,fontSize:11.5,color:"#89CFF0",marginBottom:9,lineHeight:1.45 }}>Target: {workout.target || (apiWorkout?.exercises?.slice(0,3).map(e=>e.muscleGroup).filter(Boolean).join(', ')) || 'Full Body'}</div>
              <div style={{ display:"flex",gap:14,alignItems:"center" }}>
                {[{val:workout.duration||workout.mins||0,icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,col:"#EF4444"},{val:workout.calories||workout.cal||0,icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="#FF6B35"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>,col:"#FF6B35"},{val:Array.isArray(workout.exercises)?workout.exercises.length:(workout.exercises||0),icon:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/></svg>,col:PRIMARY}].map((s,i)=>(
                  <div key={i} style={{ display:"flex",alignItems:"center",gap:4 }}>
                    {s.icon}<span style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:s.col }}>{s.val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ height:1,background:BORDER,margin:"0 0 14px" }}/>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:11 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:14,color:"#fff" }}>Exercise Preview</div>
            <span onClick={()=>onNavigate("workoutDetail", workout)} style={{ fontFamily:FONT,fontSize:12,color:PRIMARY,cursor:"pointer",fontWeight:600 }}>View All</span>
          </div>
          <div style={{ display:"flex",gap:9,marginBottom:16,overflowX:"auto" }}>
            {exPreview.map((ex, i) => {
              const imgSrc = ex?.thumbnailUrl || ex?.img || null;
              const initials = (ex?.name || '').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase() || '•';
              return (
                <div key={i} onClick={()=>onNavigate("workoutDetail", workout)} style={{ minWidth:76,width:76,height:76,borderRadius:12,overflow:"hidden",flexShrink:0,cursor:"pointer" }}>
                  {imgSrc
                    ? <img src={imgSrc} alt={ex?.name||''} style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
                    : <div style={{ width:"100%",height:"100%",background:"linear-gradient(135deg,#1a1a2e,#16213e)",display:"flex",alignItems:"center",justifyContent:"center" }}>
                        <span style={{ fontFamily:FONT,fontWeight:800,fontSize:15,color:"#556" }}>{initials}</span>
                      </div>
                  }
                </div>
              );
            })}
          </div>
          {!workoutDone?(
            <button onClick={()=>onNavigate("workoutDetail", workout)} style={{ width:"100%",padding:"15px 0",borderRadius:50,border:"none",background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,fontFamily:FONT,fontWeight:800,fontSize:13.5,color:"#fff",letterSpacing:2,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,boxShadow:`0 4px 28px ${PRIMARY}55` }}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="white"><polygon points="0,0 13,6.5 0,13"/></svg>
              START WORKOUT
            </button>
          ):(
            <div onClick={()=>onNavigate("aiSummary")} style={{ background:"#0c1c0c",border:"1px solid #1a3a1a",borderRadius:14,padding:"13px 16px",display:"flex",alignItems:"center",gap:12,cursor:"pointer" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <div>
                <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13.5,color:"#22C55E" }}>Workout Complete!</div>
                <div style={{ fontFamily:FONT,fontSize:11.5,color:"#1a4a1a" }}>Tap to view AI analysis</div>
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Streak Freeze sheet */}
      {showFreezeSheet&&(
        <>
          <div onClick={()=>setShowFreezeSheet(false)} style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.82)",zIndex:60 }}/>
          <div style={{ position:"absolute",bottom:0,left:0,right:0,background:CARD,borderRadius:"24px 24px 0 0",padding:"28px 24px 44px",zIndex:61,border:`1px solid ${BORDER}`,borderBottom:"none" }}>
            <div style={{ display:"flex",justifyContent:"center",marginBottom:16 }}><div style={{ width:40,height:4,borderRadius:2,background:"#2a2a2a" }}/></div>
            <div style={{ textAlign:"center",marginBottom:22 }}>
              <div style={{ width:60,height:60,borderRadius:"50%",background:`${PRIMARY}18`,border:`1px solid ${PRIMARY}44`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px" }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="1.8">
                  <line x1="12" y1="2" x2="12" y2="22"/><path d="M17 7l-5-5-5 5"/><path d="M17 17l-5 5-5-5"/>
                  <line x1="2" y1="12" x2="22" y2="12"/><path d="M7 7l-5 5 5 5"/><path d="M17 7l5 5-5 5"/>
                </svg>
              </div>
              <div style={{ fontFamily:FONT,fontWeight:900,fontSize:20,color:"#fff",marginBottom:8 }}>Activate Streak Freeze?</div>
              <div style={{ fontFamily:FONT,fontSize:13.5,color:"#888",lineHeight:1.65 }}>Your streak will be protected today even if you miss your workout. You have <span style={{color:PRIMARY,fontWeight:700}}>1 freeze</span> available this week.</div>
            </div>
            <button onClick={activateFreeze} style={{ width:"100%",padding:"16px 0",borderRadius:50,background:`linear-gradient(135deg,${PRIMARY},#0068CC)`,border:"none",fontFamily:FONT,fontWeight:800,fontSize:14,color:"#fff",letterSpacing:1.5,cursor:"pointer",marginBottom:10,boxShadow:`0 4px 24px ${PRIMARY}55` }}>
              ACTIVATE FREEZE
            </button>
            <button onClick={()=>setShowFreezeSheet(false)} style={{ width:"100%",padding:"13px 0",borderRadius:50,background:"transparent",border:`1px solid ${BORDER}`,fontFamily:FONT,fontWeight:600,fontSize:13,color:"#888",cursor:"pointer" }}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}


// ── SPLASH SCREEN ─────────────────────────────────────────────────────────────
function SplashScreen() {
  const [visible, setVisible] = useState(false);
  useEffect(()=>{ const t = setTimeout(()=>setVisible(true), 60); return ()=>clearTimeout(t); }, []);
  return (
    <div style={{
      position:"absolute", inset:0, background:"#000",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      gap:0,
    }}>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12,
        opacity: visible ? 1 : 0, transform: visible ? "scale(1)" : "scale(0.88)",
        transition:"opacity 0.6s ease, transform 0.6s ease" }}>
        <VTRXLogo size={64}/>
        <div style={{ fontFamily:FONT, fontWeight:900, fontSize:28, color:PRIMARY, letterSpacing:8, lineHeight:1 }}>
          VTRX
        </div>
      </div>
    </div>
  );
}

function VTRXAppInner({ setPaymentPlan }) {

  const { user, setUser, profileImg, isPremium, setIsPremium } = useUser();
  const { isLoaded: clerkLoaded, isSignedIn, getToken } = useClerkAuth();
  const { signOut: clerkSignOut } = useClerk();

  // ── Phase / onboarding state ──────────────────────────────────────────────
  const [phase, setPhase]           = useState("splash");
  const [pendingEmail,    setPendingEmail]    = useState("");
  const [pendingPassword, setPendingPassword] = useState(""); // held only for auto-login after email verify
  const [screen, setScreen]         = useState(0);
  const [dir, setDir]               = useState(1);
  const goNext = () => { setDir(1);  setScreen(s=>s+1); };
  const goPrev = () => { setDir(-1); setScreen(s=>Math.max(0,s-1)); };
  const goToDashboard = async () => {
    // Guard: if the user hasn't completed goal/fitness-level setup, route them
    // back to preferences rather than showing a broken empty dashboard
    if (!user?.goal || !user?.fitnessLevel) {
      setPhase('preferences');
      setScreen(0);
      return;
    }
    // Save onboarding profile to backend.
    // skipAuthRedirect: this is the final step of onboarding — a transient 401 here
    // must not force a full sign-out (the user has just finished setup and has this
    // data locally in state regardless; better to proceed to the dashboard than to
    // bounce them all the way back to login).
    if (!DEMO_MODE && isSignedIn) {
      try {
        await apiCall("/users/profile", {
          method: "PUT",
          skipAuthRedirect: true,
          body: JSON.stringify({
            ...(user.name && { name: user.name }),
            gender:               user.gender,
            weight:               user.weight,
            height:               user.height,
            goal:                 user.goal,
            fitnessLevel:         user.level || user.fitnessLevel,
            daysPerWeek:          parseInt(user.days || user.daysPerWeek) || 5,
            equipment:            user.equipment,
            location:             user.location || user.workoutLocation,
            nutritionGoal:        user.nutritionGoal,
            dietaryRestrictions:  user.dietaryRestrictions || [],
            mealsPerDay:          user.mealsPerDay,
            wantsMealSuggestions: user.wantsMealSuggestions,
            trackingPreference:   user.trackingPreference,
            preferredStyles:      user.preferredStyles || [],
            sessionDuration:      user.sessionDuration,
          }),
        });
      } catch(_e){}
      // Fire-and-forget: generate free AI onboarding analysis + schedule 5-min notification
      apiCall("/ai/onboarding-analysis", { method: "POST", skipAuthRedirect: true }).catch(() => {});
    }
    if (!isSignedIn) {
      setPhase("login");
      return;
    }
    setPhase("dashboard");
  };

  // ── Dashboard state ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState(0);
  const [innerPage, setInnerPage] = useState(null);
  const [selectedExercise, setSelectedExercise] = useState(null);
  const [selectedScheduleWorkout, setSelectedScheduleWorkout] = useState(null);
  const [workoutDone, setWorkoutDone] = useState(false);
  const [lastWorkoutLogId, setLastWorkoutLogId] = useState(null);
  const [lastWorkoutStats, setLastWorkoutStats] = useState({ calories:0, duration:0, exercises:0, name:"", date:"" });
  const [loggedWorkouts,   setLoggedWorkouts]   = useState([]);
  const [weeklyWorkoutDays,setWeeklyWorkoutDays]= useState(0);
  const [weeklyAvgCal,     setWeeklyAvgCal]     = useState(null);
  const [weeklyAvgMin,     setWeeklyAvgMin]     = useState(null);
  const [workoutElapsed,   setWorkoutElapsed]   = useState(0);
  const [workoutStarted,   setWorkoutStarted]   = useState(false);
  const [workoutPaused,    setWorkoutPaused]    = useState(false);
  const [completedExNames, setCompletedExNames] = useState([]);
  const [loggedExSets,    setLoggedExSets]    = useState({}); // { exerciseName: [{reps,weight},...] }
  const workoutTimerRef = useRef(null);

  useEffect(()=>{
    const active = (innerPage==="workoutDetail"||innerPage==="exerciseDetail") && workoutStarted && !workoutDone && !workoutPaused;
    if (active) { workoutTimerRef.current = setInterval(()=>setWorkoutElapsed(t=>t+1),1000); }
    else { clearInterval(workoutTimerRef.current); }
    return ()=>clearInterval(workoutTimerRef.current);
  }, [innerPage, workoutStarted, workoutDone, workoutPaused]);
  const [showComplete, setShowComplete] = useState(false);
  const [mealIdx, setMealIdx] = useState(0);
  const [streakDay, setStreakDay] = useState(0);
  const [workoutsTotal,setWorkoutsTotal]= useState(0);
  const [energyKey, setEnergyKey] = useState(()=>{
    try {
      const saved = JSON.parse(localStorage.getItem("vtrx_mood")||"{}");
      const today = new Date().toLocaleDateString('en-CA');
      return saved.date===today ? saved.key : null; // null = show MoodSheet
    } catch(_e){ return null; }
  });
  const [notifCount,    setNotifCount]    = useState(0);
  const [liveUser,      setLiveUser]      = useState(null);
  const [apiWorkout,    setApiWorkout]    = useState(null);
  // Show "Enable notifications" banner if permission not yet decided
  const [showPushBanner, setShowPushBanner] = useState(false);
  const [navExpanded,    setNavExpanded]    = useState(true);
  const dashScrollRef  = useRef(null);
  const savedScrollPos = useRef(0);
  const mouseStart     = useRef(null);
  const touchStart     = useRef(null);
  const handleAppBackRef = useRef(null);

  // Push one sentinel history entry so the first back press fires popstate instead
  // of leaving the app. Must be declared before any early returns to satisfy rules of hooks.
  useEffect(() => {
    window.history.pushState({ vtrx: true }, '', window.location.pathname);
    const onPopState = () => {
      const handled = handleAppBackRef.current?.();
      if (handled) {
        window.history.pushState({ vtrx: true }, '', window.location.pathname);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Fetch today's AI-generated daily workout (ymove-first).
  // Cache the result in localStorage keyed by userId+date so re-mounts don't burn API quota.
  useEffect(()=>{
    const userId = liveUser?.id;
    if (!isSignedIn || !userId) return;

    const today    = new Date().toLocaleDateString('en-CA');
    const cacheKey = `vtrx_daily_workout_${userId}`;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached?.workout && cached?.date === today) { setApiWorkout(cached.workout); return; }
    } catch (_e) {}

    apiCall('/workouts/generate-daily', { method: 'POST' })
      .then(d => {
        if (d?.data?.workout) {
          setApiWorkout(d.data.workout);
          try { localStorage.setItem(cacheKey, JSON.stringify({ ...d.data, date: today })); } catch (_e) {}
        }
      })
      .catch(()=>{
        // Fallback: use recommend endpoint if generate-daily fails
        apiCall(`/workouts/recommend?energyLevel=${energyKey || 'okay'}`)
          .then(d => { if (d?.data?.recommendation) setApiWorkout(d.data.recommendation); })
          .catch(()=>{});
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUser?.id]);

  // Load real data on mount — also drives splash → onboarding/dashboard transition
  const _splashRanRef = useRef(false);
  useEffect(()=>{
    if (!clerkLoaded || _splashRanRef.current) return;
    _splashRanRef.current = true;

    const MIN_SPLASH_MS = 2500;
    const splashStart   = Date.now();
    const afterSplash   = (nextPhase) => {
      const elapsed = Date.now() - splashStart;
      const delay   = Math.max(0, MIN_SPLASH_MS - elapsed);
      setTimeout(() => setPhase(nextPhase), delay);
    };

    if (DEMO_MODE) { afterSplash("onboarding"); return; }
    if (!isSignedIn) { afterSplash("onboarding"); return; }

    // skipAuthRedirect: this is the initial app-load fetch, fired on every page
    // load/refresh for an already-signed-in user. It already falls back to
    // onboarding on failure below — a transient 401 here shouldn't force an
    // actual Clerk sign-out for a user who is genuinely still signed in.
    apiCall("/users/profile", { skipAuthRedirect: true }).then(res=>{
      if (res?.data?.user) {
        const u = res.data.user;
        setUser(prev=>({...prev,
          id:                   u.id                   ?? prev.id,
          name:                 u.name                 ?? prev.name,
          email:                u.email                ?? prev.email,
          username:             u.username             ?? prev.username,
          avatarUrl:            u.avatarUrl            ?? prev.avatarUrl,
          goal:                 u.goal                 ?? prev.goal,
          fitnessLevel:         u.fitnessLevel         ?? prev.fitnessLevel,
          level:                u.fitnessLevel         ?? prev.level,
          daysPerWeek:          u.daysPerWeek          ?? prev.daysPerWeek,
          days:                 u.daysPerWeek          ?? prev.days,
          weight:               u.weight               ?? prev.weight,
          height:               u.height               ?? prev.height,
          gender:               u.gender               ?? prev.gender,
          age:                  u.age                  ?? prev.age,
          equipment:            u.equipment            ?? prev.equipment            ?? [],
          location:             u.location             ?? prev.location,
          sessionDuration:      u.sessionDuration      ?? prev.sessionDuration,
          preferredStyles:      u.preferredStyles      ?? prev.preferredStyles      ?? [],
          wantsMealSuggestions: u.wantsMealSuggestions ?? prev.wantsMealSuggestions,
          nutritionGoal:        u.nutritionGoal        ?? prev.nutritionGoal,
          trackingPreference:   u.trackingPreference   ?? prev.trackingPreference,
          dietaryRestrictions:  u.dietaryRestrictions  ?? prev.dietaryRestrictions  ?? [],
          mealsPerDay:          u.mealsPerDay          ?? prev.mealsPerDay,
          bodyFatPercentage:    u.bodyFatPercentage    ?? prev.bodyFatPercentage,
          goalWeightLbs:        u.goalWeightLbs        ?? prev.goalWeightLbs,
        }));
        if (u.streakDays)           setStreakDay(u.streakDays);
        if (u._count?.workoutLogs)  setWorkoutsTotal(u._count.workoutLogs);
        if (u.isPremium)            setIsPremium(true);
        if (u.subscription)         setUser(prev=>({...prev, subscription: u.subscription}));
        identifyUser({ ...u, isPremium: u.isPremium });
        afterSplash("dashboard");
      } else {
        afterSplash("onboarding");
      }
      apiCall("/workouts/stats").then(sr=>{
        if (sr?.data?.stats) {
          const s = sr.data.stats;
          if (s.currentStreak)                  setStreakDay(s.currentStreak);
          if (s.workoutsCompleted !== undefined) setWeeklyWorkoutDays(s.workoutsCompleted);
          if (s.avgCalories)                    setWeeklyAvgCal(s.avgCalories);
          if (s.avgMinutes)                     setWeeklyAvgMin(s.avgMinutes);
          if (s.totalWorkouts)                  setWorkoutsTotal(s.totalWorkouts);
        }
      }).catch(()=>{});
    }).catch(()=>{ afterSplash("onboarding"); });
  }, [clerkLoaded, isSignedIn]);

  // ── Handle Stripe redirect on app load ─────────────────────────────────────
  useEffect(()=>{
    const params    = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (sessionId && getAuthToken()) {
      apiCall("/payments/verify-session", {
        method: "POST",
        body:   JSON.stringify({ sessionId }),
      }).then(res=>{
        if (res?.data?.isPremium) {
          setIsPremium(true);
          setPhase("dashboard");
          window.history.replaceState({}, "", "/");
        }
      }).catch(()=>{});
    }
  }, []);

  // Register the module-level bridge so any component can call openPaymentSheet()
  useEffect(()=>{
    _openPaymentSheet = (plan) => setPaymentPlan(plan || "monthly");
    return () => { _openPaymentSheet = null; };
  }, []);

  // Register Clerk token getter as module-level bridge for apiCall()
  useEffect(()=>{
    _getClerkToken = () => getToken();
    return () => { _getClerkToken = null; };
  }, [getToken]);

  useEffect(() => { _isSignedIn = isSignedIn; return () => { _isSignedIn = false; }; }, [isSignedIn]);

  // When any protected API call returns 401, clear auth and send to login.
  // The 500ms delay avoids false logouts during navigation where a 401 can
  // transiently fire before the new route establishes a fresh token context.
  useEffect(()=>{
    _onSessionExpired = () => {
      clerkSignOut().catch(()=>{}).finally(() => {
        clearAuth();
        setUser({ name:"", age:"", gender:"", weight:"", height:"", goal:"", level:"", days:5 });
        setIsPremium(false);
        setPhase("login");
      });
    };
    return () => { _onSessionExpired = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show "Enable notifications" banner only if browser actually supports web push
  useEffect(()=>{
    if (phase !== "dashboard") return;
    if (typeof Notification === "undefined") return;
    isPushSupported().then(supported => {
      if (!supported) return;
      if (Notification.permission === "default") setShowPushBanner(true);
      if (Notification.permission === "granted") registerPushToken();
    });
  }, [phase]);

  const registerPushToken = async () => {
    try {
      const token = await getNotificationToken();
      if (token) {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        await apiCall('/notifications/register', {
          method: 'POST',
          body: JSON.stringify({ token, platform: 'web', timezone }),
        });
      }
    } catch(_e) {}
  };

  const handleEnableNotifications = async () => {
    setShowPushBanner(false);
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') await registerPushToken();
    } catch(_e) {}
  };

  // Listen for foreground push messages and increment badge
  useEffect(()=>{
    let unsub = () => {};
    onForegroundMessage(payload => {
      setNotifCount(c => c + 1);
    }).then(fn => { unsub = fn; });
    return () => unsub();
  }, []);

  // Collapse floating nav when dashboard is scrolled down
  useEffect(()=>{
    const el = dashScrollRef.current;
    if (!el) return;
    const onScroll = () => { if (el.scrollTop > 40) setNavExpanded(false); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(()=>{
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
      } catch(_e){}
    };
    if (phase === "dashboard") loadData();
  }, [phase]);

  // ── Splash screen ─────────────────────────────────────────────────────────
  if (phase==="splash") {
    return <SplashScreen/>;
  }

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

  if (phase==="emailVerify") return (
    <EmailVerifyScreen
      email={pendingEmail}
      onVerified={()=>{
        // Clerk already established the session in EmailVerifyScreen via setActive()
        setPendingPassword("");
        setPhase("preferences"); setScreen(2);
      }}
      onBack={()=>setPhase("login")}
    />
  );
  if (phase==="login") return (
    <LoginScreen
      onLogin={(u) => {
        // u comes from /users/profile — use it directly to avoid stale user state
        if (u?.goal && u?.fitnessLevel) {
          setPhase("dashboard");
        } else {
          // No onboarding complete yet — send to body metrics (skip signup/verify)
          setPhase("preferences"); setScreen(2);
        }
      }}
      onSignUp={()=>{ setPhase("preferences"); setScreen(0); }}
      onForgot={()=>setPhase("forgot")}
      onEmailVerify={(email)=>{ setPendingEmail(email); setPhase("emailVerify"); }}/>
  );
  if (phase==="forgot") return (
    <ForgotPasswordPage onBack={()=>setPhase("login")}/>
  );

  if (phase==="preferences") {
    const SCREENS = [
      <SignUpScreen              key={0} onContinue={(email, password)=>{ if(email){ setPendingEmail(email); setPendingPassword(password||""); setPhase("emailVerify"); } else goNext(); }} onBack={()=>setPhase("onboarding")} onLogin={()=>setPhase("login")}/>,
      <EmailVerifyScreen   key={1} email={pendingEmail} onVerified={goNext} onBack={goPrev}/>,
      <BodyScreen                key={2} onContinue={goNext} onBack={goPrev}/>,
      <WorkoutScreen             key={3} onContinue={goNext} onBack={goPrev}/>,
      <NutritionScreen           key={4} onContinue={goNext} onBack={goPrev}/>,
      <PricingScreen             key={5} onContinue={goNext} onBack={goPrev}/>,
      <ReadyScreen               key={6} onFinish={goToDashboard}/>,
    ];
    return SCREENS[Math.min(screen, SCREENS.length-1)];
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    try {
      await clerkSignOut();
    } catch(_e){} finally {
      resetAnalytics();
      clearAuth();
    }
    setUser({ name:"", age:"", gender:"", weight:"", height:"", goal:"", level:"", days:5 });
    setIsPremium(false);
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

  const handleTabSelect = (i) => {
    setActiveTab(i);
    setInnerPage(null);
    setSelectedScheduleWorkout(null);
    setTimeout(() => setNavExpanded(false), 250);
  };

  const navigate = (page, workoutData = null) => {
    if (dashScrollRef.current) savedScrollPos.current = dashScrollRef.current.scrollTop;
    if (workoutData) setSelectedScheduleWorkout(workoutData);
    else setSelectedScheduleWorkout(null);
    setInnerPage(page);
  };

  const goBack = () => {
    // Reset timer when leaving workout
    if (innerPage === "workoutDetail") {
      clearInterval(workoutTimerRef.current);
      setWorkoutStarted(false);
      setWorkoutElapsed(0);
    }
    setSelectedScheduleWorkout(null);
    setInnerPage(null);
    setSelectedExercise(null);
    requestAnimationFrame(()=>{
      if (dashScrollRef.current) dashScrollRef.current.scrollTop = savedScrollPos.current;
    });
  };

  // ── Browser back-button handler ───────────────────────────────────────────
  // Assign the latest closure to the stable ref each render so the popstate
  // listener (registered once above, before early returns) always calls current logic.
  handleAppBackRef.current = () => {
    if (_backHandler) { _backHandler(); return true; }
    if (innerPage === "exerciseDetail") { setInnerPage("workoutDetail"); return true; }
    if (innerPage !== null) { goBack(); return true; }
    if (phase === "preferences") {
      if (screen > 0) { goPrev(); return true; }
      setPhase("onboarding"); setScreen(ONBOARDING_SLIDES.length - 1); return true;
    }
    if (phase === "login")       { setPhase("onboarding"); setScreen(ONBOARDING_SLIDES.length - 1); return true; }
    if (phase === "forgot")      { setPhase("login"); return true; }
    if (phase === "emailVerify") { setPhase("login"); return true; }
    if (phase === "onboarding" && screen > 0) { setScreen(s => Math.max(0, s - 1)); return true; }
    if (phase === "dashboard" && activeTab !== 0) { handleTabSelect(0); return true; }
    return false;
  };

  if (phase !== "dashboard") return null;

  // Inner pages
  if (innerPage==="myPlan")        return <MyPlanPage onBack={goBack} onNavigate={navigate}/>;
  if (innerPage==="upgrade")       return <UpgradePlanPage onBack={goBack}/>;
  if (innerPage==="aiSummary")     return <AISummaryPage energyKey={energyKey} workoutDone={workoutDone} logId={lastWorkoutLogId} onBack={goBack}/>;
  if (innerPage==="nutrition")     return <NutritionPage meal={MEALS[mealIdx % MEALS.length]} onBack={goBack}/>;
  if (innerPage==="fitnessStats")  return <FitnessStatsPage onBack={goBack} loggedWorkouts={loggedWorkouts}/>;
  if (innerPage==="notifications") return <NotificationsPage onBack={goBack}/>;
  if (innerPage==="profile") return <ProfilePage onBack={goBack} onLogout={handleLogout} onNavigate={navigate} streakDay={streakDay} workoutsTotal={workoutsTotal}/>;
  if (innerPage==="workoutDetail") {
    const fallbackW = WEEKLY_WORKOUTS[TODAY_IDX % WEEKLY_WORKOUTS.length];
    const activeW   = selectedScheduleWorkout || apiWorkout || fallbackW;
    return <WorkoutDetailPage
      workout={activeW}
      elapsed={workoutElapsed} started={workoutStarted}
      paused={workoutPaused}
      completedExercises={completedExNames}
      onTogglePause={()=>setWorkoutPaused(p=>!p)}
      onBack={goBack}
      onStart={()=>{ setWorkoutStarted(true); setWorkoutPaused(false); track("workout_started", { name: activeW?.name, type: activeW?.type }); }}
      onStop={async (elapsedSeconds=0, completedExList=[], pct=0)=>{
        const mins      = Math.max(1, Math.round(elapsedSeconds / 60));
        const wType     = (activeW.type || "strength").toLowerCase();
        const minMins   = wType === "cardio" ? 5 : 10;
        const needsSets = wType === "strength" || wType === "hiit";
        // Capture before clearing state
        const snapExNames  = completedExNames;
        const snapExSets   = loggedExSets;

        console.log('Workout abandoned with:', { completionPercentage: pct, exercisesCompleted: snapExNames.length, totalExercises: (activeW.exercises||[]).length, durationMins: mins });
        clearInterval(workoutTimerRef.current);
        track("workout_stopped", { name: activeW?.name, type: wType, durationMins: mins, completionPct: pct, exercisesLogged: snapExNames.length });
        setWorkoutDone(false);
        setWorkoutStarted(false);
        setWorkoutPaused(false);
        setWorkoutElapsed(0);
        setCompletedExNames([]);
        setLoggedExSets({});

        if (pct > 0 && mins >= minMins && (!needsSets || snapExNames.length > 0)) {
          try {
            let exPayload = Object.entries(snapExSets).map(([name, doneSets]) => ({
              name,
              sets: doneSets.map((s, idx) => ({
                setNumber: idx + 1,
                reps:   s.reps   ? parseInt(s.reps)    : undefined,
                weight: s.weight ? parseFloat(s.weight) : undefined,
              })),
            }));
            if (!exPayload.length) {
              exPayload = (activeW.exercises || []).map(e => ({
                exerciseId: e.id || undefined,
                name:       e.name,
                sets:       [{ setNumber:1, reps: parseReps(e.reps || e.detail || '10') }],
              }));
            }
            const logRes = await apiCall("/workouts/log", {
              method: "POST",
              body: JSON.stringify({
                workoutId:            activeW.workoutId || undefined,
                name:                 activeW.name,
                type:                 activeW.type,
                duration:             mins,
                caloriesBurned:       Math.round((activeW.calories || activeW.cal || 300) * (pct / 100)),
                energyLevel:          energyKey || "okay",
                completionPercentage: pct,
                exercises:            exPayload,
              }),
            });
            if (logRes?.data?.workoutLog?.id) setLastWorkoutLogId(logRes.data.workoutLog.id);
            const today     = new Date();
            const calBurned = Math.round((activeW.calories||activeW.cal||300)*(pct/100));
            setLoggedWorkouts(prev => [...prev, { date:today, type:wType, cal:calBurned, duration:mins, name:activeW.name }]);
          } catch(_e){}
        }
        setInnerPage(null);
        setActiveTab(0);
      }}
      onComplete={async (elapsedSeconds=0)=>{
        const mins      = Math.max(1, Math.round(elapsedSeconds / 60));
        const wType     = (activeW.type || "strength").toLowerCase();
        const minMins   = wType === "cardio" ? 5 : 10;
        const needsSets = wType === "strength" || wType === "hiit";
        const actCal    = activeW.calories || activeW.cal || 300;
        // Capture before clearing state
        const snapExNames = completedExNames;
        const snapExSets  = loggedExSets;

        const shouldLog = mins >= minMins && (!needsSets || snapExNames.length > 0);

        if (shouldLog) {
          track("workout_completed", { name: activeW?.name, type: wType, durationMins: mins, caloriesBurned: actCal, exercisesLogged: snapExNames.length, energyLevel: energyKey });
          setWorkoutDone(true);
          setStreakDay(s=>s+1);
          setWorkoutsTotal(t=>t+1);
          setWeeklyWorkoutDays(d=>d+1);
          setWeeklyAvgCal(prev=>{
            const prevTotal = prev !== null ? prev * weeklyWorkoutDays : 0;
            return Math.round((prevTotal + actCal) / (weeklyWorkoutDays + 1));
          });
          setWeeklyAvgMin(prev=>{
            const prevTotal = prev !== null ? prev * weeklyWorkoutDays : 0;
            return Math.round((prevTotal + mins) / (weeklyWorkoutDays + 1));
          });
          try {
            let exPayload = Object.entries(snapExSets).map(([name, doneSets]) => ({
              name,
              sets: doneSets.map((s, idx) => ({
                setNumber: idx + 1,
                reps:   s.reps   ? parseInt(s.reps)    : undefined,
                weight: s.weight ? parseFloat(s.weight) : undefined,
              })),
            }));
            if (!exPayload.length) {
              exPayload = (activeW.exercises || []).map(e => ({
                exerciseId: e.id || undefined,
                name:       e.name,
                sets:       [{ setNumber:1, reps: e.reps || e.detail || '8' }],
              }));
            }
            const completeRes = await apiCall("/workouts/log", {
              method: "POST",
              body: JSON.stringify({
                workoutId:            activeW.workoutId || undefined,
                name:                 activeW.name,
                type:                 activeW.type,
                duration:             mins,
                caloriesBurned:       actCal,
                energyLevel:          energyKey || "okay",
                completionPercentage: 100,
                exercises:            exPayload,
              }),
            });
            if (completeRes?.data?.workoutLog?.id) setLastWorkoutLogId(completeRes.data.workoutLog.id);
            const me = await apiCall("/users/profile");
            if (me?.data?.user?.streakDays) setStreakDay(me.data.user.streakDays);
            if (me?.data?.user?._count?.workoutLogs) setWorkoutsTotal(me.data.user._count.workoutLogs);
            const sr = await apiCall("/workouts/stats");
            if (sr?.data?.stats) {
              const s = sr.data.stats;
              if (s.workoutsCompleted !== undefined) setWeeklyWorkoutDays(s.workoutsCompleted);
              if (s.avgCalories) setWeeklyAvgCal(s.avgCalories);
              if (s.avgMinutes)  setWeeklyAvgMin(s.avgMinutes);
            }
          } catch(_e){}
          const today   = new Date();
          const dateStr = today.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
          const timeStr = today.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });
          setLoggedWorkouts(prev => [...prev, { date:today, type:wType, cal:actCal, duration:mins, name:activeW.name }]);
          setLastWorkoutStats({
            calories:  actCal,
            duration:  mins,
            exercises: Array.isArray(activeW.exercises) ? activeW.exercises.length : (activeW.exercises || 3),
            name:      activeW.name || "Workout",
            date:      dateStr,
            time:      timeStr,
          });
          setShowComplete(true);
        }

        setWorkoutStarted(false);
        setWorkoutPaused(false);
        setWorkoutElapsed(0);
        setCompletedExNames([]);
        setLoggedExSets({});
        setInnerPage(null);
        setActiveTab(0);
      }}
      onExercise={(ex)=>{ setSelectedExercise(ex); setInnerPage("exerciseDetail"); }}/>;
  };
  if (innerPage==="exerciseDetail"&&selectedExercise) return <ExercisePage
    exercise={selectedExercise}
    onBack={()=>setInnerPage("workoutDetail")}
    onComplete={(doneSets=[])=>{
      if (selectedExercise?.name) {
        setCompletedExNames(prev=>[...new Set([...prev, selectedExercise.name])]);
        if (doneSets.length) setLoggedExSets(prev=>({...prev, [selectedExercise.name]: doneSets}));
      }
      setInnerPage("workoutDetail");
    }}/>;

  return (
    <div style={{ position:"absolute",inset:0,background:BG,display:"flex",flexDirection:"column",overflow:"hidden" }}>
      {/* Workout Complete overlay */}
      {showComplete&&(
        <WorkoutCompleteScreen
          workoutName={lastWorkoutStats.name}
          date={lastWorkoutStats.date}
          time={lastWorkoutStats.time}
          calories={lastWorkoutStats.calories}
          durationMins={lastWorkoutStats.duration}
          exercises={lastWorkoutStats.exercises}
          streakDay={streakDay}
          onViewAI={()=>{ setShowComplete(false); navigate("aiSummary"); }}
          onDone={()=>{ setShowComplete(false); }}
        />
      )}

      {/* Main content area */}
      <div style={{ flex:1,position:"relative",overflow:"hidden" }}>
        {activeTab===0&&!innerPage&&(
          <Dashboard
            userProfile={{daysPerWeek: user?.daysPerWeek || 5}}
            weeklyWorkoutDays={weeklyWorkoutDays}
            weeklyAvgCal={weeklyAvgCal}
            weeklyAvgMin={weeklyAvgMin}
            apiWorkout={apiWorkout}
            scrollRef={dashScrollRef}
            mealIdx={mealIdx}
            setMealIdx={setMealIdx}
            streakDay={streakDay}
            energyKey={energyKey}
            notifCount={notifCount}
            onNotifReset={()=>setNotifCount(0)}
            onMoodSelect={(key)=>{
              setEnergyKey(key);
              track("mood_logged", { mood: key });
              try { localStorage.setItem("vtrx_mood", JSON.stringify({key, date:new Date().toLocaleDateString('en-CA')})); } catch(_e){}
              if (!DEMO_MODE && getAuthToken()) {
                apiCall("/users/mood", { method:"POST", body:JSON.stringify({ mood:key }) }).catch(()=>{});
              }
            }}
            onNavigate={(page)=>{ if(page==="workoutDetail"){ setWorkoutDone(false); setWorkoutStarted(false); setWorkoutElapsed(0); setSelectedScheduleWorkout(null); } if(page==="nutritionPlan"){setActiveTab(1);return;} navigate(page); }}
            onLogout={handleLogout}
          />
        )}
        {activeTab===1&&!innerPage&&(
          <NutritionHub onBack={()=>setActiveTab(0)} energyKey={energyKey} onLogout={handleLogout}/>
        )}
        {activeTab===2&&!innerPage&&(
          <WeightsHub onLogout={handleLogout} onNavigate={navigate} loggedWorkouts={loggedWorkouts}/>
        )}
      </div>

      {/* Push notification permission banner */}
      {showPushBanner && !innerPage && (
        <div style={{ position:"absolute",bottom:110,left:12,right:12,zIndex:60,background:"#1a1a1a",border:`1px solid ${PRIMARY}44`,borderRadius:16,padding:"14px 16px",display:"flex",alignItems:"center",gap:12,boxShadow:"0 4px 24px rgba(0,0,0,0.5)",animation:"fadeUp 0.3s ease both" }}>
          <div style={{ width:36,height:36,borderRadius:"50%",background:`${PRIMARY}22`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:FONT,fontWeight:700,fontSize:13,color:"#fff",marginBottom:2 }}>Enable notifications</div>
            <div style={{ fontFamily:FONT,fontSize:11,color:"#888" }}>Get streak alerts, AI summaries & workout reminders</div>
          </div>
          <div style={{ display:"flex",gap:8,flexShrink:0 }}>
            <button onClick={()=>setShowPushBanner(false)} style={{ background:"none",border:"none",fontFamily:FONT,fontSize:12,color:"#555",cursor:"pointer",padding:"4px 8px" }}>Not now</button>
            <button onClick={handleEnableNotifications} style={{ background:PRIMARY,border:"none",borderRadius:20,padding:"6px 14px",fontFamily:FONT,fontWeight:700,fontSize:12,color:"#fff",cursor:"pointer" }}>Allow</button>
          </div>
        </div>
      )}

      {/* Floating nav pill */}
      {!innerPage&&(
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:96, pointerEvents:"none", zIndex:50 }}>
          <div style={{
            position:"absolute",
            bottom: 28,
            left:      navExpanded ? "50%" : 20,
            transform: navExpanded ? "translateX(-50%)" : "translateX(0)",
            transition:"left 0.42s cubic-bezier(0.34,1.56,0.64,1), transform 0.42s cubic-bezier(0.34,1.56,0.64,1)",
            background:"rgba(18,18,18,0.96)",
            backdropFilter:"blur(24px)",
            borderRadius: navExpanded ? 32 : 28,
            border:`1px solid ${BORDER}`,
            boxShadow:"0 8px 32px rgba(0,0,0,0.55)",
            display:"flex",
            alignItems:"center",
            overflow:"hidden",
            pointerEvents:"all",
          }}>
            {navExpanded ? (
              /* ── Expanded: all three tabs ── */
              TABS.map((t,i) => (
                <button key={i} onClick={()=>handleTabSelect(i)}
                  style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"10px 20px",background:"none",border:"none",cursor:"pointer",position:"relative" }}>
                  {activeTab===i && (
                    <div style={{ position:"absolute",inset:0,borderRadius:24,background:`${PRIMARY}18` }}/>
                  )}
                  <svg width="22" height="22" viewBox="0 0 24 24" fill={activeTab===i?PRIMARY:"none"} stroke={activeTab===i?PRIMARY:"#555"} strokeWidth="1.8">
                    {t.iconType==="home"      &&<><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>}
                    {t.iconType==="nutrition" &&<><path d="M3 2v7a1 1 0 001 1h1v12a1 1 0 002 0V10h1a1 1 0 001-1V2"/><line x1="5" y1="2" x2="5" y2="9"/><path d="M19 2c0 0-2 2-2 5s2 5 2 5v8a1 1 0 01-2 0V2"/></>}
                    {t.iconType==="workout"   &&<path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/>}
                  </svg>
                  <span style={{ fontFamily:FONT,fontSize:10,fontWeight:700,letterSpacing:0.3,color:activeTab===i?PRIMARY:"#555",position:"relative" }}>{t.label}</span>
                </button>
              ))
            ) : (
              /* ── Collapsed: active icon only — tap to expand ── */
              <button onClick={()=>setNavExpanded(true)}
                style={{ width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",background:"none",border:"none",cursor:"pointer" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill={PRIMARY} stroke={PRIMARY} strokeWidth="1.6">
                  {TABS[activeTab]?.iconType==="home"      &&<><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>}
                  {TABS[activeTab]?.iconType==="nutrition" &&<><path d="M3 2v7a1 1 0 001 1h1v12a1 1 0 002 0V10h1a1 1 0 001-1V2"/><line x1="5" y1="2" x2="5" y2="9"/><path d="M19 2c0 0-2 2-2 5s2 5 2 5v8a1 1 0 01-2 0V2"/></>}
                  {TABS[activeTab]?.iconType==="workout"   &&<path d="M1 7h4v10H1zM5 9h2.5v6H5zM7.5 11h9v2H7.5zM16.5 9h2.5v6H16.5zM19 7h4v10H19z"/>}
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

// ─────────────────────────────────────────────────────────────────────────────

}
// ── ROOT APP ──────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function VTRXApp() {
  const [user, setUser] = useState({ name:"", age:"", gender:"", weight:"", height:"", goal:"", level:"", days:5 });
  const [profileImg, setProfileImg] = useState(null);
  const [isPremium, setIsPremium] = useState(false);
  const [paymentPlan, setPaymentPlan] = useState(null);
  return (
    <UserCtx.Provider value={{ user, setUser, profileImg, setProfileImg, isPremium, setIsPremium }}>
      <VTRXAppInner setPaymentPlan={setPaymentPlan}/>
      {paymentPlan && <PaymentSheet initialPlan={paymentPlan} onClose={()=>setPaymentPlan(null)}/>}
    </UserCtx.Provider>
  );
}

export default VTRXApp;
