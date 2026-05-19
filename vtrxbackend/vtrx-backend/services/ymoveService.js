// ─────────────────────────────────────────────────────────────────────────────
// services/ymoveService.js — Ymove Platform Integration
// ─────────────────────────────────────────────────────────────────────────────
// Ymove is your content provider for:
// - Workout videos
// - Exercise tutorials
// - Nutrition recipes
//
// HOW TO GET YOUR YMOVE API DETAILS:
// Contact Ymove and ask them:
// 1. "What is your API base URL?"
// 2. "What authentication method do you use?" (API key, OAuth, Bearer token?)
// 3. "What endpoints are available?" (workouts, exercises, recipes, videos?)
// 4. "Is there a sandbox/test environment?"
// 5. "What rate limits apply?"
//
// Once you have answers, update this file with the real endpoints.
// The rest of the app will work without changes.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require('axios');
const logger = require('../utils/logger');

// Base configuration — update YMOVE_API_URL in .env when you have it
const ymoveApi = axios.create({
  baseURL: process.env.YMOVE_API_URL || 'https://api.ymove.com/v1',
  timeout: 10000, // 10 second timeout
  headers: {
    'Authorization': `Bearer ${process.env.YMOVE_API_KEY}`,
    'Content-Type':  'application/json',
  },
});

// ── Request interceptor — log every outgoing request ──────────────────────────
ymoveApi.interceptors.request.use((config) => {
  logger.info(`Ymove API → ${config.method?.toUpperCase()} ${config.url}`);
  return config;
});

// ── Response interceptor — handle errors consistently ─────────────────────────
ymoveApi.interceptors.response.use(
  (response) => response,
  (error) => {
    logger.error(`Ymove API error: ${error.response?.status} ${error.message}`);
    throw error;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// WORKOUT METHODS
// ─────────────────────────────────────────────────────────────────────────────

// Get a list of workouts — update endpoint when you have Ymove docs
const getWorkouts = async ({ type, difficulty, limit = 20, offset = 0 } = {}) => {
  try {
    // TODO: Update this endpoint when you get Ymove API documentation
    const response = await ymoveApi.get('/workouts', {
      params: { type, difficulty, limit, offset },
    });
    return response.data;
  } catch (error) {
    logger.warn('Ymove getWorkouts failed — returning empty array');
    return { workouts: [], total: 0 };
  }
};

// Get a single workout with full exercise details
const getWorkoutById = async (ymoveId) => {
  try {
    // TODO: Update endpoint
    const response = await ymoveApi.get(`/workouts/${ymoveId}`);
    return response.data;
  } catch (error) {
    logger.warn(`Ymove getWorkout ${ymoveId} failed`);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISE METHODS
// ─────────────────────────────────────────────────────────────────────────────

const getExercises = async ({ muscleGroup, equipment, search, limit = 20 } = {}) => {
  try {
    // TODO: Update endpoint
    const response = await ymoveApi.get('/exercises', {
      params: { muscleGroup, equipment, search, limit },
    });
    return response.data;
  } catch (error) {
    logger.warn('Ymove getExercises failed');
    return { exercises: [] };
  }
};

// Get a secure video URL for an exercise (may be a pre-signed S3 URL)
const getExerciseVideoUrl = async (ymoveExerciseId) => {
  try {
    // TODO: Update endpoint — Ymove may return a CDN URL or signed URL
    const response = await ymoveApi.get(`/exercises/${ymoveExerciseId}/video`);
    return response.data?.videoUrl || null;
  } catch (error) {
    logger.warn(`Ymove video URL failed for ${ymoveExerciseId}`);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NUTRITION / RECIPE METHODS
// ─────────────────────────────────────────────────────────────────────────────

const getRecipes = async ({ tags, goal, limit = 20, offset = 0 } = {}) => {
  try {
    // TODO: Update endpoint
    const response = await ymoveApi.get('/nutrition/recipes', {
      params: { tags, goal, limit, offset },
    });
    return response.data;
  } catch (error) {
    logger.warn('Ymove getRecipes failed');
    return { recipes: [] };
  }
};

const getRecipeById = async (ymoveId) => {
  try {
    // TODO: Update endpoint
    const response = await ymoveApi.get(`/nutrition/recipes/${ymoveId}`);
    return response.data;
  } catch (error) {
    logger.warn(`Ymove getRecipe ${ymoveId} failed`);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────

// Test if Ymove API is reachable
const checkConnection = async () => {
  try {
    // TODO: Update to Ymove's health endpoint if they have one
    await ymoveApi.get('/health');
    return true;
  } catch (error) {
    logger.warn('Ymove API not reachable:', error.message);
    return false;
  }
};

module.exports = {
  getWorkouts,
  getWorkoutById,
  getExercises,
  getExerciseVideoUrl,
  getRecipes,
  getRecipeById,
  checkConnection,
};
