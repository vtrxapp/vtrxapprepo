// ─────────────────────────────────────────────────────────────────────────────
// src/services/api.js — Central API Client
// ─────────────────────────────────────────────────────────────────────────────
// This creates a pre-configured Axios instance that:
// 1. Automatically adds the auth token to every request
// 2. Handles 401 errors by logging the user out
// 3. Has consistent error handling across the whole app
//
// Every other service file imports from here instead of using fetch/axios directly.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import config from '@/config';

// Create the Axios instance
const api = axios.create({
  baseURL: config.apiUrl,
  timeout: 15000, // 15 seconds — fail if no response
  headers: {
    'Content-Type': 'application/json',
  },
});

// ── Request Interceptor ───────────────────────────────────────────────────────
// Runs BEFORE every request is sent
// Automatically attaches the user's JWT token
api.interceptors.request.use(
  (requestConfig) => {
    const token = localStorage.getItem('vtrx_token');
    if (token) {
      requestConfig.headers.Authorization = `Bearer ${token}`;
    }
    return requestConfig;
  },
  (error) => Promise.reject(error)
);

// ── Response Interceptor ──────────────────────────────────────────────────────
// Runs after EVERY response (success or error)
api.interceptors.response.use(
  // Success: just return the response data
  (response) => response.data,

  // Error: handle common cases
  async (error) => {
    const originalRequest = error.config;

    // 401 = token expired or invalid
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      const code = error.response?.data?.code;

      if (code === 'TOKEN_EXPIRED') {
        // Could refresh the token here in a more advanced setup
        // For now, log out and redirect to login
        localStorage.removeItem('vtrx_token');
        localStorage.removeItem('vtrx_user');
        window.location.href = '/';
        return;
      }
    }

    // Format the error message cleanly for the UI
    const message =
      error.response?.data?.message ||
      error.message ||
      'Something went wrong. Please try again.';

    // Attach a clean message to the error object
    error.userMessage = message;
    error.statusCode  = error.response?.status;
    error.code        = error.response?.data?.code;

    return Promise.reject(error);
  }
);

export default api;
