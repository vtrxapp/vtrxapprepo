// ─────────────────────────────────────────────────────────────────────────────
// src/services/ymoveService.js — Ymove Content Service (Frontend)
// ─────────────────────────────────────────────────────────────────────────────
// This calls our BACKEND which then calls Ymove.
// We never call Ymove directly from the frontend — that would expose our API key.
//
// Update this once you have Ymove API documentation.
// ─────────────────────────────────────────────────────────────────────────────

import api from './api';

// Get workout videos from Ymove (via our backend)
export const getYmoveWorkouts = async (filters = {}) => {
  return api.get('/workouts', { params: { ...filters, source: 'ymove' } });
};

// Get exercise tutorial video URL
export const getExerciseVideo = async (exerciseId) => {
  return api.get(`/workouts/exercises/${exerciseId}/video`);
};

// Get recipes from Ymove
export const getYmoveRecipes = async (filters = {}) => {
  return api.get('/nutrition/recipes', { params: { ...filters, source: 'ymove' } });
};
