// ─────────────────────────────────────────────────────────────────────────────
// services/ymoveService.js — ymove.app Exercise API Integration
// ─────────────────────────────────────────────────────────────────────────────
// API docs:  https://ymove.app/exercise-api/docs
// Sign up:   https://ymove.app/exercise-api/signup  (free trial, no CC needed)
// Base URL:  https://exercise-api.ymove.app/api/v2
// Auth:      X-API-Key header  (set YMOVE_API_KEY in Railway environment)
//
// Video URLs are pre-signed CDN links that EXPIRE after 48 hours.
// Always fetch fresh — never cache the URL itself; cache the exercise metadata.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require('axios');
const logger = require('../utils/logger');

const YMOVE_BASE = process.env.YMOVE_API_URL || 'https://exercise-api.ymove.app/api/v2';

const ymoveApi = axios.create({
  baseURL: YMOVE_BASE,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Inject key at request time so hot-reloaded env vars are picked up
ymoveApi.interceptors.request.use(config => {
  const key = process.env.YMOVE_API_KEY;
  if (!key) logger.warn('YMOVE_API_KEY not set — ymove requests will fail with 401');
  config.headers['X-API-Key'] = key || '';
  logger.info(`ymove → ${config.method?.toUpperCase()} ${config.url}`);
  return config;
});

ymoveApi.interceptors.response.use(
  res  => res,
  err => {
    const status = err.response?.status;
    if (status === 401)      logger.error('ymove 401 — check YMOVE_API_KEY in Railway env');
    else if (status === 429) logger.warn('ymove rate-limited');
    else                     logger.error(`ymove error ${status}: ${err.message}`);
    throw err;
  }
);

const isConfigured = () => !!process.env.YMOVE_API_KEY;

// Normalise response shapes
const toArray = r => Array.isArray(r) ? r : (r?.data || r?.exercises || r?.items || r?.results || []);

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISES
// ─────────────────────────────────────────────────────────────────────────────

// GET /exercises
// Filters: muscleGroup, exerciseType, equipment, difficulty, hasVideo, search
const getExercises = async ({ muscleGroup, exerciseType, equipment, difficulty, hasVideo, search, limit = 20, page = 1 } = {}) => {
  if (!isConfigured()) return { exercises: [], total: 0 };
  try {
    const { data } = await ymoveApi.get('/exercises', {
      params: {
        ...(muscleGroup  && { muscleGroup }),
        ...(exerciseType && { exerciseType }),
        ...(equipment    && { equipment }),
        ...(difficulty   && { difficulty }),
        ...(hasVideo !== undefined && { hasVideo }),
        ...(search       && { search }),
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

// GET /exercises/muscle-groups — available muscle groups with exercise counts
const getMuscleGroups = async () => {
  if (!isConfigured()) return [];
  try {
    const { data } = await ymoveApi.get('/exercises/muscle-groups');
    return toArray(data);
  } catch {
    return [];
  }
};

// GET /exercises/exercise-types — available exercise types with counts
const getExerciseTypes = async () => {
  if (!isConfigured()) return [];
  try {
    const { data } = await ymoveApi.get('/exercises/exercise-types');
    return toArray(data);
  } catch {
    return [];
  }
};

// Returns a fresh non-expired video URL for an exercise (video URLs expire after 48h)
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

// Batch-fetch video URLs — serial to respect rate limits
const getBatchVideoUrls = async (ymoveIds = []) => {
  const result = {};
  for (const id of ymoveIds) {
    result[id] = await getExerciseVideoUrl(id);
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// WORKOUT GENERATION
// ─────────────────────────────────────────────────────────────────────────────

// GET /workouts/generate — generate a workout by muscle group / params
// Params: muscleGroup, difficulty, equipment, exerciseCount
const generateWorkout = async ({ muscleGroup, difficulty, equipment, exerciseCount = 6 } = {}) => {
  if (!isConfigured()) return null;
  try {
    const { data } = await ymoveApi.get('/workouts/generate', {
      params: {
        ...(muscleGroup    && { muscleGroup }),
        ...(difficulty     && { difficulty }),
        ...(equipment      && { equipment }),
        ...(exerciseCount  && { exerciseCount }),
      },
    });
    return data?.data || data || null;
  } catch {
    logger.warn('ymove generateWorkout failed');
    return null;
  }
};

// Legacy listing (used in existing workout browse routes)
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
// PROGRAM GENERATION
// ─────────────────────────────────────────────────────────────────────────────

// GET /programs/generate — generate a multi-week training program
// Params: goal, weeks, daysPerWeek, difficulty, equipment
const generateProgram = async ({ goal, weeks = 4, daysPerWeek = 3, difficulty, equipment } = {}) => {
  if (!isConfigured()) return null;
  try {
    const { data } = await ymoveApi.get('/programs/generate', {
      params: {
        ...(goal         && { goal }),
        ...(weeks        && { weeks }),
        ...(daysPerWeek  && { daysPerWeek }),
        ...(difficulty   && { difficulty }),
        ...(equipment    && { equipment }),
      },
    });
    return data?.data || data || null;
  } catch {
    logger.warn('ymove generateProgram failed');
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AI POSTURE ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

// POST /posture/analyze — AI posture analysis from a base64 image or URL
// imageData: { url: '...' } or { base64: '...', mimeType: 'image/jpeg' }
const analyzePosture = async ({ imageUrl, base64, mimeType = 'image/jpeg', exerciseId } = {}) => {
  if (!isConfigured()) return null;
  try {
    const payload = {
      ...(imageUrl  && { image_url: imageUrl }),
      ...(base64    && { image_base64: base64, mime_type: mimeType }),
      ...(exerciseId && { exercise_id: exerciseId }),
    };
    const { data } = await ymoveApi.post('/posture/analyze', payload);
    return data?.data || data || null;
  } catch {
    logger.warn('ymove analyzePosture failed');
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// USAGE / HEALTH
// ─────────────────────────────────────────────────────────────────────────────

// GET /usage — check API usage and limits
const getUsage = async () => {
  if (!isConfigured()) return null;
  try {
    const { data } = await ymoveApi.get('/usage');
    return data?.data || data || null;
  } catch {
    return null;
  }
};

const checkConnection = async () => {
  if (!isConfigured()) return false;
  try {
    await ymoveApi.get('/exercises', { params: { limit: 1 } });
    return true;
  } catch {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NUTRITION / RECIPES (own DB — ymove API does not expose nutrition endpoints)
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

module.exports = {
  isConfigured,
  // Exercises
  getExercises,
  getExerciseById,
  getMuscleGroups,
  getExerciseTypes,
  getExerciseVideoUrl,
  getBatchVideoUrls,
  // Workouts
  getWorkouts,
  getWorkoutById,
  generateWorkout,
  // Programs
  generateProgram,
  // Posture
  analyzePosture,
  // Usage
  getUsage,
  checkConnection,
  // Nutrition (own DB)
  getRecipes,
  getRecipeById,
};
