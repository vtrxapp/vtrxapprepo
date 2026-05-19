// ─────────────────────────────────────────────────────────────────────────────
// src/hooks/useWorkouts.js — Workout Data Hook
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from 'react';
import * as workoutService from '@/services/workoutService';
import useApi from './useApi';

// Fetch workout history
export const useWorkoutHistory = (options = {}) => {
  return useApi(workoutService.getWorkoutHistory, null, options);
};

// Fetch weekly stats
export const useWeeklyStats = () => {
  return useApi(workoutService.getWeeklyStats);
};

// Log a workout with loading state
export const useLogWorkout = () => {
  const [isLogging, setIsLogging] = useState(false);
  const [logError,  setLogError]  = useState(null);

  const logWorkout = useCallback(async (workoutData) => {
    setIsLogging(true);
    setLogError(null);
    try {
      const result = await workoutService.logWorkout(workoutData);
      return result;
    } catch (err) {
      setLogError(err.userMessage || 'Failed to log workout');
      throw err;
    } finally {
      setIsLogging(false);
    }
  }, []);

  return { logWorkout, isLogging, logError };
};
