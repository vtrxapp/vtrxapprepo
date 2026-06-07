// ─────────────────────────────────────────────────────────────────────────────
// src/main.jsx — Application Entry Point
// ─────────────────────────────────────────────────────────────────────────────
// Vite starts here. This mounts your React app into the HTML page.
// ─────────────────────────────────────────────────────────────────────────────
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);