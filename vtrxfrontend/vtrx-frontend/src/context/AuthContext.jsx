// ─────────────────────────────────────────────────────────────────────────────
// src/context/AuthContext.jsx — Global Authentication State
// ─────────────────────────────────────────────────────────────────────────────
// Context is React's way of sharing data between components without
// passing props down through every level.
//
// This AuthContext makes the current user available to any component in the app.
// Usage: const { user, login, logout, isLoading } = useAuth();
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as authService from '@/services/authService';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user,      setUser]      = useState(null);
  const [isLoading, setIsLoading] = useState(true); // true until we know if user is logged in
  const [error,     setError]     = useState(null);

  // ── Check if user is already logged in (on page load) ─────────────────────
  useEffect(() => {
    const initAuth = async () => {
      const storedUser = authService.getStoredUser();
      const token      = localStorage.getItem('vtrx_token');

      if (storedUser && token) {
        // Optimistically set user from localStorage (fast)
        setUser(storedUser);

        // Verify token is still valid with the server
        try {
          const result = await authService.getMe();
          if (result.data?.user) {
            setUser(result.data.user);
            localStorage.setItem('vtrx_user', JSON.stringify(result.data.user));
          }
        } catch {
          // Token is invalid/expired — log out
          authService.logout();
          setUser(null);
        }
      }

      setIsLoading(false);
    };

    initAuth();
  }, []);

  // ── Login ──────────────────────────────────────────────────────────────────
  const login = useCallback(async (credentials) => {
    setError(null);
    const result = await authService.login(credentials);
    if (result.success) {
      setUser(result.data.user);
    }
    return result;
  }, []);

  // ── Signup ─────────────────────────────────────────────────────────────────
  const signup = useCallback(async (userData) => {
    setError(null);
    return authService.signup(userData);
  }, []);

  // ── Logout ─────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
  }, []);

  // ── Update user (after profile changes) ───────────────────────────────────
  const updateUser = useCallback((updates) => {
    setUser(prev => {
      const updated = { ...prev, ...updates };
      localStorage.setItem('vtrx_user', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const value = {
    user,
    isLoading,
    error,
    isAuthenticated: !!user,
    isPremium:       !!user?.isPremium,
    login,
    signup,
    logout,
    updateUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

// Custom hook — use this in any component to access auth state
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
