// ─────────────────────────────────────────────────────────────────────────────
// src/main.jsx — Application Entry Point
// ─────────────────────────────────────────────────────────────────────────────
// Vite starts here. This mounts your React app into the HTML page.
// ─────────────────────────────────────────────────────────────────────────────
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';

// ─────────────────────────────────────────────────────────────────────────────
// Clerk Initialization (Fixed for Vite)
// ─────────────────────────────────────────────────────────────────────────────
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!publishableKey) {
  throw new Error(
    'Missing Clerk Publishable Key. ' +
    'Make sure VITE_CLERK_PUBLISHABLE_KEY is set in your .env file and Vercel Environment Variables.'
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkProvider 
      publishableKey={publishableKey}
      afterSignUpUrl="/dashboard"     // ← Change these if your routes are different
      afterSignInUrl="/dashboard"
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
    >
      <App />
    </ClerkProvider>
  </StrictMode>
);