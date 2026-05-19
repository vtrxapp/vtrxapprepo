// ─────────────────────────────────────────────────────────────────────────────
// src/hooks/useApi.js — Data Fetching Hook
// ─────────────────────────────────────────────────────────────────────────────
// A reusable hook that handles loading states, errors, and retrying.
// Instead of writing this boilerplate in every component, use this hook.
//
// Usage:
//   const { data, isLoading, error, refetch } = useApi(workoutService.getWorkouts);
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from 'react';

const useApi = (apiFn, params = null, options = {}) => {
  const {
    immediate = true,  // Fetch immediately on mount
    onSuccess = null,  // Callback on success
    onError   = null,  // Callback on error
  } = options;

  const [data,      setData]      = useState(null);
  const [isLoading, setIsLoading] = useState(immediate);
  const [error,     setError]     = useState(null);

  // Prevent state updates on unmounted components
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const execute = useCallback(async (overrideParams) => {
    if (!mounted.current) return;

    setIsLoading(true);
    setError(null);

    try {
      const callParams = overrideParams ?? params;
      const result     = callParams ? await apiFn(callParams) : await apiFn();

      if (!mounted.current) return;

      const responseData = result?.data || result;
      setData(responseData);
      onSuccess?.(responseData);
      return responseData;

    } catch (err) {
      if (!mounted.current) return;
      const errMessage = err.userMessage || err.message || 'Something went wrong';
      setError(errMessage);
      onError?.(errMessage);
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, [apiFn, params]); // eslint-disable-line

  useEffect(() => {
    if (immediate) execute();
  }, []); // eslint-disable-line

  return { data, isLoading, error, refetch: execute };
};

export default useApi;
