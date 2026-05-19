# VTRX Frontend — Vite Migration Guide
## Connecting Your Existing JSX App to the Real Backend

---

## What you now have

```
vtrx-frontend/
├── index.html                        ← HTML entry point
├── vite.config.js                    ← Build configuration
├── amplify.yml                       ← AWS Amplify deployment config
├── package.json                      ← Dependencies
├── .env.example                      ← Copy to .env
│
└── src/
    ├── main.jsx                      ← App entry point
    ├── App.jsx                       ← Router + Auth setup
    ├── VTRXApp.jsx                   ← Your existing app (rename vtrx-app-v2.jsx)
    │
    ├── config/
    │   └── index.js                  ← Central config (API URL, feature flags)
    │
    ├── context/
    │   └── AuthContext.jsx           ← Global auth state (useAuth hook)
    │
    ├── services/                     ← All API calls
    │   ├── api.js                    ← Axios instance with auth interceptors
    │   ├── authService.js            ← signup, login, logout
    │   ├── workoutService.js         ← workouts, history, AI summaries
    │   ├── nutritionService.js       ← recipes, meal plan, saved meals
    │   ├── userService.js            ← profile, mood, progress, notifications
    │   └── ymoveService.js           ← Ymove content (via backend)
    │
    ├── hooks/
    │   ├── useApi.js                 ← Generic data fetching with loading/error
    │   └── useWorkouts.js            ← Workout-specific hooks
    │
    ├── components/
    │   ├── ProtectedRoute.jsx        ← Guards pages that need login
    │   ├── LoadingSpinner.jsx        ← Spinner + skeleton loaders
    │   ├── ErrorBoundary.jsx         ← Catches React errors
    │   ├── AIRecommendationCard.jsx  ← Live AI coaching card
    │   └── ProgressChart.jsx         ← Chart.js analytics charts
    │
    └── utils/
        └── index.js                  ← Shared helper functions
```

---

## STEP 1 — Set up the project

```bash
# Navigate to vtrx-frontend folder
cd vtrx-frontend

# Install dependencies
npm install

# Copy env file and fill in values
cp .env.example .env
```

Open `.env` and set:
```
VITE_API_URL=http://localhost:5000/api
```
(When backend is deployed: `VITE_API_URL=https://your-api.com/api`)

---

## STEP 2 — Add your existing app

Copy your `vtrx-app-v2.jsx` into the `src/` folder and rename it `VTRXApp.jsx`.

Then update the import in `App.jsx` — it's already set up to import from `./VTRXApp`.

---

## STEP 3 — Connect login to the real API

In your `VTRXApp.jsx`, the `LoginScreen` currently sets local state.
Here's how to wire it to the real backend:

**Before (mock login):**
```jsx
const handleLogin = () => {
  setPhase("dashboard");
};
```

**After (real API login):**
```jsx
import { useAuth } from './context/AuthContext';

// Inside your component:
const { login } = useAuth();

const handleLogin = async (email, password) => {
  setIsLoading(true);
  try {
    const result = await login({ email, password });
    if (result.success) {
      setPhase("dashboard");
    }
  } catch (err) {
    setLoginError(err.userMessage || 'Login failed');
  } finally {
    setIsLoading(false);
  }
};
```

Do the same for signup, logout, and forgot password.

---

## STEP 4 — Connect workout logging

When the user taps "Complete Workout":

```jsx
import * as workoutService from './services/workoutService';

const handleCompleteWorkout = async () => {
  try {
    const result = await workoutService.logWorkout({
      name:           workout.name,
      type:           workout.type,
      duration:       workout.duration,
      caloriesBurned: workout.cal,
      generateAI:     true,  // triggers AI summary generation
      energyLevel:    energyKey,
    });

    // Navigate to success screen
    setWorkoutDone(true);

    // After a moment, fetch the AI summary
    if (result.data?.workoutLog?.id) {
      const summary = await workoutService.getAISummary(result.data.workoutLog.id);
      setAiSummary(summary?.data?.summary);
    }
  } catch (err) {
    console.error('Failed to log workout:', err);
  }
};
```

---

## STEP 5 — Replace static recipes with API data

In your `NutritionHub`, replace the `RECIPES` constant with an API call:

```jsx
import * as nutritionService from './services/nutritionService';
import useApi from './hooks/useApi';

// Inside NutritionHub:
const { data, isLoading, error } = useApi(nutritionService.getRecipes);
const recipes = data?.recipes || RECIPES; // fallback to static while loading
```

---

## STEP 6 — Run the app

Make sure your backend is running first:
```bash
# Terminal 1 — Backend
cd vtrx-backend && npm run dev

# Terminal 2 — Frontend
cd vtrx-frontend && npm run dev
```

Open: http://localhost:5173

---

## STEP 7 — Deploy to AWS Amplify

1. Push both folders to a GitHub repository
2. Go to AWS Console → Amplify → New App → Host web app
3. Connect your GitHub repo
4. Amplify auto-detects `amplify.yml` and uses it
5. Add environment variables in Amplify Console:
   - `VITE_API_URL` = your deployed backend URL
   - `VITE_COGNITO_POOL_ID`, `VITE_COGNITO_CLIENT_ID`, `VITE_AWS_REGION`
6. Deploy — Amplify gives you a URL like `https://main.xxxx.amplifyapp.com`

**IMPORTANT:** The `amplify.yml` already includes the React Router rewrite rule.
This means refreshing on `/dashboard` won't 404.

---

## Connecting to Ymove (once you have API docs)

1. Ask Ymove for their API base URL and authentication method
2. Update `YMOVE_API_URL` and `YMOVE_API_KEY` in your backend `.env`
3. Update the TODO endpoints in `backend/services/ymoveService.js`
4. Set `features.ymoveVideos = true` in `src/config/index.js`

**Questions to ask Ymove:**
- What is the API base URL?
- How do I authenticate? (API key in header? OAuth? Bearer token?)
- What endpoints exist for workouts, exercises, and recipes?
- Do you have a sandbox/test environment?
- What are the rate limits?
- Are video URLs direct CDN links or pre-signed S3 URLs?

---

## Architecture Summary

```
User taps "Login" in VTRX app
        ↓
authService.login() called
        ↓
POST /api/auth/login sent to backend
        ↓
Backend calls AWS Cognito
        ↓
Cognito verifies password → returns tokens
        ↓
Backend issues our JWT + returns user
        ↓
Frontend stores token in localStorage
        ↓
All future API calls include the token automatically
        ↓
Middleware verifies token on every protected route
```

---

## Common Issues

**"Network Error" on API calls**
→ Make sure backend is running (`npm run dev` in vtrx-backend)
→ Check VITE_API_URL in frontend .env matches backend PORT

**"CORS Error" in browser**
→ Check FRONTEND_URL in backend .env matches `http://localhost:5173`

**"Token expired" on every request**
→ Log out and log back in — your JWT has expired

**Amplify deploy 404 on refresh**
→ The `amplify.yml` rewrites rule handles this — make sure it deployed correctly
