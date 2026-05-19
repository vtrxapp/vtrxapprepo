// ─────────────────────────────────────────────────────────────────────────────
// src/utils/index.js — Shared Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

// Format a date string to "May 14" style
export const formatDate = (dateString) => {
  return new Date(dateString).toLocaleDateString('en-GB', {
    month: 'short', day: 'numeric',
  });
};

// Format duration in minutes to "1h 20m"
export const formatDuration = (minutes) => {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

// Format large numbers: 2300 → "2,300"
export const formatNumber = (n) => {
  return n?.toLocaleString() ?? '0';
};

// Get CDN URL for a media asset
export const getCdnUrl = (path) => {
  const cdn = import.meta.env.VITE_CDN_URL;
  if (!cdn || !path) return path;
  return `${cdn}/${path}`;
};

// Capitalize first letter
export const capitalize = (str) => {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

// Debounce a function (useful for search inputs)
export const debounce = (fn, delay = 300) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

// Get greeting based on time of day
export const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

// Map mood key to display label
export const MOOD_LABELS = {
  empty: 'Rest Day',
  low:   'Low Energy',
  okay:  'Feeling Okay',
  good:  'Feeling Good',
  peak:  'Peak Energy',
};

// Map workout type to colour
export const WORKOUT_TYPE_COLORS = {
  STRENGTH: '#00A3FF',
  CARDIO:   '#EF4444',
  HIIT:     '#F97316',
  RECOVERY: '#22C55E',
  REST:     '#888888',
};
