// ─────────────────────────────────────────────────────────────────────────────
// src/services/authService.js — Authentication Service
// Auth is handled by Clerk on the backend (clerkService.js).
// The app uses a custom JWT issued on login — not Clerk sessions.
// ─────────────────────────────────────────────────────────────────────────────

import api from './api';

export const signup = async ({ email, password, username, name, gender, age }) => {
  return api.post('/auth/signup', { email, password, username, name, gender, age });
};

export const confirmEmail = async ({ email, code, verificationId }) => {
  return api.post('/auth/confirm-email', { email, code, verificationId });
};

export const login = async ({ email, password }) => {
  const data = await api.post('/auth/login', { email, password });
  if (data.success) {
    localStorage.setItem('vtrx_token', data.data.token);
    localStorage.setItem('vtrx_user',  JSON.stringify(data.data.user));
  }
  return data;
};

export const logout = async () => {
  try {
    await api.post('/auth/logout', {});
  } finally {
    localStorage.removeItem('vtrx_token');
    localStorage.removeItem('vtrx_user');
  }
};

export const forgotPassword = async ({ email }) => api.post('/auth/forgot-password', { email });

export const resetPassword = async ({ email, code, newPassword }) =>
  api.post('/auth/reset-password', { email, code, newPassword });

export const getMe = async () => api.get('/auth/me');

export const getStoredUser = () => {
  try {
    const user = localStorage.getItem('vtrx_user');
    return user ? JSON.parse(user) : null;
  } catch {
    return null;
  }
};

export const isAuthenticated = () => !!localStorage.getItem('vtrx_token');
