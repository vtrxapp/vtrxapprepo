// ─────────────────────────────────────────────────────────────────────────────
// vite.config.js — Build Tool Configuration
// ─────────────────────────────────────────────────────────────────────────────
// Vite is your build tool — it compiles your React code into files browsers
// can understand, and provides a fast development server.
// ─────────────────────────────────────────────────────────────────────────────

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      // Allows you to import from "@/components/..." instead of "../../components/..."
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: 5173,
    // Proxy API requests to your backend during development
    // This avoids CORS issues when testing locally
    proxy: {
      '/api': {
        target:      'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir:    'dist',
    sourcemap: false, // Set to true for debugging production issues
    rollupOptions: {
      output: {
        // Split code into chunks for faster loading
        manualChunks: {
          vendor:  ['react', 'react-dom', 'react-router-dom'],
          charts:  ['chart.js', 'react-chartjs-2'],
          network: ['axios'],
        },
      },
    },
  },
});
