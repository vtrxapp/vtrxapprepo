// ─────────────────────────────────────────────────────────────────────────────
// src/services/nutritionService.js — Nutrition Service
// ─────────────────────────────────────────────────────────────────────────────

import api from './api';

export const getRecipes = async (filters = {}) => {
  return api.get('/nutrition/recipes', { params: filters });
};

export const getRecipeById = async (id) => {
  return api.get(`/nutrition/recipes/${id}`);
};

export const getSavedRecipes = async () => {
  return api.get('/nutrition/saved');
};

export const saveRecipe = async (recipeId) => {
  return api.post('/nutrition/saved', { recipeId });
};

export const unsaveRecipe = async (recipeId) => {
  return api.delete(`/nutrition/saved/${recipeId}`);
};

export const getMealPlan = async () => {
  return api.get('/nutrition/meal-plan');
};
