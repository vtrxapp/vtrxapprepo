// ─────────────────────────────────────────────────────────────────────────────
// src/config/index.js — App Configuration
// ─────────────────────────────────────────────────────────────────────────────

const config = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',

  // Clerk (auth provider)
  clerk: {
    publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || '',
  },

  cdnUrl:  import.meta.env.VITE_CDN_URL   || '',
  appName: import.meta.env.VITE_APP_NAME  || 'VTRX',
  isDev:   import.meta.env.VITE_APP_ENV  !== 'production',

  features: {
    aiSummaries:    true,
    community:      false,
    challenges:     false,
    ymoveVideos:    false,
    progressPhotos: true,
  },
};

export default config;
