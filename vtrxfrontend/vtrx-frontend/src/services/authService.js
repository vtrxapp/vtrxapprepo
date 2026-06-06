// ─────────────────────────────────────────────────────────────────────────────
// src/services/authService.js — Authentication Service
// ─────────────────────────────────────────────────────────────────────────────
// All authentication API calls in one place.
// Your components call these functions — they never call the API directly.
// ─────────────────────────────────────────────────────────────────────────────

import api from './api';

// ── Sign Up ───────────────────────────────────────────────────────────────────
export const signup = async ({ email, password, username, name, gender, age }) => {
  const data = await api.post('/auth/signup', {
    email, password, username, name, gender, age,
  });
  return data;
};

// ── Confirm Email (after signup) ──────────────────────────────────────────────
// ── Confirm Email (after signup) ──────────────────────────────────────────────
export const confirmEmail = async ({ email, code, verificationId }) => {
  return api.post('/auth/confirm-email', { 
    email, 
    code, 
    verificationId   // ← This was missing
  });
};

// ── Login ─────────────────────────────────────────────────────────────────────
export const login = async ({ email, password }) => {
  const data = await api.post('/auth/login', { email, password });

  if (data.success) {
    // Store the token and user in localStorage for persistence
    // This means the user stays logged in after refreshing the page
    localStorage.setItem('vtrx_token', data.data.token);
    localStorage.setItem('vtrx_user',  JSON.stringify(data.data.user));

    // Also store Cognito access token (needed for logout)
    if (data.data.cognitoTokens?.accessToken) {
      localStorage.setItem('vtrx_cognito_token', data.data.cognitoTokens.accessToken);
    }
  }

  return data;
};

// ── Logout ────────────────────────────────────────────────────────────────────
export const logout = async () => {
  const cognitoAccessToken = localStorage.getItem('vtrx_cognito_token');

  try {
    await api.post('/auth/logout', { cognitoAccessToken });
  } finally {
    // Always clear local storage, even if the API call fails
    localStorage.removeItem('vtrx_token');
    localStorage.removeItem('vtrx_user');
    localStorage.removeItem('vtrx_cognito_token');
  }
};

// ── Forgot Password ───────────────────────────────────────────────────────────
export const forgotPassword = async ({ email }) => {
  return api.post('/auth/forgot-password', { email });
};

// ── Reset Password ────────────────────────────────────────────────────────────
export const resetPassword = async ({ email, code, newPassword }) => {
  return api.post('/auth/reset-password', { email, code, newPassword });
};

// ── Get Current User ──────────────────────────────────────────────────────────
export const getMe = async () => {
  return api.get('/auth/me');
};

// ── Get stored user (from localStorage — no API call) ────────────────────────
export const getStoredUser = () => {
  try {
    const user = localStorage.getItem('vtrx_user');
    return user ? JSON.parse(user) : null;
  } catch {
    return null;
  }
};

// ── Check if user is logged in ────────────────────────────────────────────────
export const isAuthenticated = () => {
  return !!localStorage.getItem('vtrx_token');
};
