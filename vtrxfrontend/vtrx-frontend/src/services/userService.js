// ─────────────────────────────────────────────────────────────────────────────
// src/services/userService.js — User Service
// ─────────────────────────────────────────────────────────────────────────────

import api from './api';

export const getProfile = async () => {
  return api.get('/users/profile');
};

export const updateProfile = async (profileData) => {
  return api.put('/users/profile', profileData);
};

export const logMood = async ({ mood, notes }) => {
  return api.post('/users/mood', { mood, notes });
};

export const getProgressLogs = async (limit = 12) => {
  return api.get('/users/progress', { params: { limit } });
};

export const logProgress = async (measurements) => {
  return api.post('/users/progress', measurements);
};

export const getNotifications = async () => {
  return api.get('/users/notifications');
};

export const markNotificationsRead = async () => {
  return api.patch('/users/notifications/read');
};
