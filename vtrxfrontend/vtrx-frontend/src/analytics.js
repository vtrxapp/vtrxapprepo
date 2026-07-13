import posthog from 'posthog-js';

// Initialise once — called from main.jsx before React mounts
export const initAnalytics = () => {
  const key  = import.meta.env.VITE_POSTHOG_KEY;
  const host = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';
  if (!key) return;
  posthog.init(key, {
    api_host:              host,
    autocapture:           true,   // clicks, inputs, page views
    capture_pageview:      true,
    capture_pageleave:     true,
    session_recording:     { maskAllInputs: true },
    persistence:           'localStorage',
    loaded: (ph) => {
      if (import.meta.env.DEV) ph.debug();
    },
  });
};

// ── Identity ──────────────────────────────────────────────────────────────────
export const identifyUser = (user) => {
  if (!user?.id && !user?.email) return;
  posthog.identify(user.id || user.email, {
    email:        user.email,
    name:         user.name,
    goal:         user.goal,
    fitnessLevel: user.fitnessLevel,
    isPremium:    user.isPremium || false,
    daysPerWeek:  user.daysPerWeek,
  });
};

export const resetAnalytics = () => posthog.reset();

// ── Event helpers ─────────────────────────────────────────────────────────────
export const track = (event, props = {}) => posthog.capture(event, props);
