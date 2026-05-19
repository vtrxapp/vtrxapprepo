// ─────────────────────────────────────────────────────────────────────────────
// src/services/workoutService.js — Workout Service
// ─────────────────────────────────────────────────────────────────────────────

import api from './api';

export const getWorkouts = async (filters = {}) => {
  return api.get('/workouts', { params: filters });
};

export const getWorkoutById = async (id) => {
  return api.get(`/workouts/${id}`);
};

export const logWorkout = async (workoutData) => {
  return api.post('/workouts/log', workoutData);
};

export const getWorkoutHistory = async ({ limit = 20, offset = 0, type } = {}) => {
  return api.get('/workouts/history', { params: { limit, offset, type } });
};

export const getWeeklyStats = async () => {
  return api.get('/workouts/stats');
};

// Polls for AI summary — retries up to 5 times with 2s delay
export const getAISummary = async (logId, retries = 5) => {
  for (let i = 0; i < retries; i++) {
    const result = await api.get(`/workouts/ai-summary/${logId}`).catch(e => e);
    if (result?.data?.summary) return result;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2000)); // wait 2s
  }
  return null;
};
