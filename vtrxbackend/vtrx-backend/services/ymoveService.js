// ─────────────────────────────────────────────────────────────────────────────
// services/ymoveService.js — ymove.app Exercise API Integration
// ─────────────────────────────────────────────────────────────────────────────
// API docs:  https://ymove.app/exercise-api/docs
// Sign up:   https://ymove.app/exercise-api/signup  (free trial, no CC needed)
// Base URL:  https://exercise-api.ymove.app/api/v2
// Auth:      X-Api-Key header  (set YMOVE_API_KEY in Railway environment)
//
// Video URLs are pre-signed CDN links that EXPIRE after 48 hours.
// Always fetch fresh — never cache the URL itself; cache the exercise metadata.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require('axios');
const logger = require('../utils/logger');

const YMOVE_BASE = process.env.YMOVE_API_URL || 'https://exercise-api.ymove.app/api/v2';
const YMOVE_KEY  = process.env.YMOVE_API_KEY;

const ymoveApi = axios.create({
  baseURL: YMOVE_BASE,
  timeout: 12000,
  headers: {
    'X-Api-Key':    YMOVE_KEY || '',
    'Content-Type': 'application/json',
  },
});

ymoveApi.interceptors.request.use(config => {
  if (!YMOVE_KEY) {
    logger.warn('YMOVE_API_KEY not set — ymove requests will fail with 401');
  }
  logger.info(`ymove → ${config.method?.toUpperCase()} ${config.url}`);
  return config;
});

ymoveApi.interceptors.response.use(
  res  => res,
  err => {
    const status = err.response?.status;
    if (status === 401) logger.error('ymove 401 — check YMOVE_API_KEY in Railway env');
    else if (status === 429) logger.warn('ymove rate-limited');
    else logger.error(`ymove error ${status}: ${err.message}`);
    throw err;
  }
);

const isConfigured = () => !!YMOVE_KEY;

// ── Normalise response — API returns data directly or wrapped in { data: [] }
const toArray = r => (Array.isArray(r) ? r : (r?.data || r?.exercises || r?.items || []));

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISES
// ─────────────────────────────────────────────────────────────────────────────

// GET /exercises — list exercises with filtering
// Params: muscle_group, equipment, difficulty, category, search, page, limit
const getExercises = async ({ muscleGroup, equipment, difficulty, category, search, limit = 20, page = 1 } = {}) => {
  if (!isConfigured()) return { exercises: [], total: 0 };
  try {
    const { data } = await ymoveApi.get('/exercises', {
      params: {
        ...(muscleGroup && { muscle_group: muscleGroup }),
        ...(equipment   && { equipment }),
        ...(difficulty  && { difficulty }),
        ...(category    && { category }),
        ...(search      && { search }),
        limit,
        page,
      },
    });
    const exercises = toArray(data);
    return { exercises, total: data?.total || exercises.length };
  } catch {
    return { exercises: [], total: 0 };
  }
};

// GET /exercises/:id — single exercise with video URL
const getExerciseById = async (ymoveId) => {
  if (!isConfigured() || !ymoveId) return null;
  try {
    const { data } = await ymoveApi.get(`/exercises/${ymoveId}`);
    return data?.data || data || null;
  } catch {
    logger.warn(`ymove getExercise ${ymoveId} failed`);
    return null;
  }
};

// Returns a fresh, non-expired video URL for an exercise.
// ymove returns video_url directly on the exercise object.
const getExerciseVideoUrl = async (ymoveId) => {
  if (!isConfigured() || !ymoveId) return null;
  try {
    const exercise = await getExerciseById(ymoveId);
    return exercise?.video_url || exercise?.videoUrl || null;
  } catch {
    logger.warn(`ymove video URL failed for ${ymoveId}`);
    return null;
  }
};

// Batch-fetch video URLs for multiple ymove IDs (respects rate limits via serial)
const getBatchVideoUrls = async (ymoveIds = []) => {
  const result = {};
  for (const id of ymoveIds) {
    result[id] = await getExerciseVideoUrl(id);
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// WORKOUTS  (ymove workout-generation endpoint)
// ─────────────────────────────────────────────────────────────────────────────

const getWorkouts = async ({ type, difficulty, limit = 20, page = 1 } = {}) => {
  if (!isConfigured()) return { workouts: [], total: 0 };
  try {
    const { data } = await ymoveApi.get('/workouts', {
      params: { type, difficulty, limit, page },
    });
    return { workouts: toArray(data), total: data?.total || 0 };
  } catch {
    return { workouts: [], total: 0 };
  }
};

const getWorkoutById = async (ymoveId) => {
  if (!isConfigured() || !ymoveId) return null;
  try {
    const { data } = await ymoveApi.get(`/workouts/${ymoveId}`);
    return data?.data || data || null;
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NUTRITION / RECIPES
// ─────────────────────────────────────────────────────────────────────────────

const getRecipes = async ({ tags, goal, limit = 20, page = 1 } = {}) => {
  if (!isConfigured()) return { recipes: [] };
  try {
    const { data } = await ymoveApi.get('/nutrition/recipes', {
      params: { tags, goal, limit, page },
    });
    return { recipes: toArray(data), total: data?.total || 0 };
  } catch {
    return { recipes: [] };
  }
};

const getRecipeById = async (ymoveId) => {
  if (!isConfigured() || !ymoveId) return null;
  try {
    const { data } = await ymoveApi.get(`/nutrition/recipes/${ymoveId}`);
    return data?.data || data || null;
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

const checkConnection = async () => {
  if (!isConfigured()) return false;
  try {
    await ymoveApi.get('/exercises', { params: { limit: 1 } });
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  isConfigured,
  getExercises,
  getExerciseById,
  getExerciseVideoUrl,
  getBatchVideoUrls,
  getWorkouts,
  getWorkoutById,
  getRecipes,
  getRecipeById,
  checkConnection,
};
