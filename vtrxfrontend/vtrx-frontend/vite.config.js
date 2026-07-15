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
    sourcemap: "hidden", // generated but not referenced in output — upload to Sentry for readable traces
    chunkSizeWarningLimit: 2000, // main bundle is ~1.5 MB (single-file app); suppress false-positive warning
    rollupOptions: {
      output: {
        // Split code into chunks for faster loading.
        // Vite 8 (rolldown) requires manualChunks as a function, not an object.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          const CHUNK_PACKAGES = {
            vendor:  ['react', 'react-dom', 'react-router-dom'],
          };
          for (const [chunk, pkgs] of Object.entries(CHUNK_PACKAGES)) {
            if (pkgs.some(pkg => id.includes(`/node_modules/${pkg}/`) || id.includes(`\\node_modules\\${pkg}\\`))) {
              return chunk;
            }
          }
        },
      },
    },
  },
});
