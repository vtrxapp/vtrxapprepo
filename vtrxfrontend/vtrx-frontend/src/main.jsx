// ─────────────────────────────────────────────────────────────────────────────
// src/main.jsx — Application Entry Point
// ─────────────────────────────────────────────────────────────────────────────
// Vite starts here. This mounts your React app into the HTML page.
// ─────────────────────────────────────────────────────────────────────────────

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// StrictMode helps catch bugs during development
// It runs certain checks twice in dev mode (doesn't affect production)
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App/>
  </StrictMode>
);
