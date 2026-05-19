// ─────────────────────────────────────────────────────────────────────────────
// src/config/index.js — App Configuration
// ─────────────────────────────────────────────────────────────────────────────
// All config values in one place.
// import.meta.env reads from your .env file (Vite's way of accessing env vars)
// ─────────────────────────────────────────────────────────────────────────────

const config = {
  // API base URL — all API calls go through this
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',

  // AWS
  aws: {
    region:        import.meta.env.VITE_AWS_REGION       || 'us-east-1',
    cognitoPoolId: import.meta.env.VITE_COGNITO_POOL_ID  || '',
    cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
  },

  // CDN for images and videos
  cdnUrl: import.meta.env.VITE_CDN_URL || '',

  // App info
  appName: import.meta.env.VITE_APP_NAME || 'VTRX',
  isDev:   import.meta.env.VITE_APP_ENV !== 'production',

  // Feature flags — turn features on/off without deploying
  features: {
    aiSummaries:    true,
    community:      false,  // Coming soon
    challenges:     false,  // Coming soon
    ymoveVideos:    false,  // Enable when Ymove API is set up
    progressPhotos: true,
  },
};

export default config;
