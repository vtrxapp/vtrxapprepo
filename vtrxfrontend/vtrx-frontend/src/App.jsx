// ─────────────────────────────────────────────────────────────────────────────
// src/App.jsx — Root Application Component
// ─────────────────────────────────────────────────────────────────────────────
// This is the top-level component. It sets up:
// 1. AuthProvider — makes auth state available everywhere
// 2. React Router — handles navigation between pages
// 3. Protected routes — guards pages that require login
// 4. ErrorBoundary — catches any uncaught errors
//
// HOW ROUTING WORKS:
// - "/" → Shows the existing VTRX app (onboarding/login/dashboard)
// - The existing vtrx-app-v2.jsx handles all internal navigation
// - Future: each major page becomes its own route for deep linking
// ─────────────────────────────────────────────────────────────────────────────

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import ErrorBoundary from '@/components/ErrorBoundary';
import ProtectedRoute from '@/components/ProtectedRoute';

// ── Page imports ──────────────────────────────────────────────────────────────
// For now, the existing JSX app handles everything.
// As you refactor, each section becomes its own page import.
import VTRXApp from './VTRXApp'; // Your existing vtrx-app-v2.jsx (renamed)

const App = () => (
  <ErrorBoundary>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Main app — handles onboarding, login, and dashboard internally */}
          <Route path="/*" element={<VTRXApp/>}/>

          {/* Future individual routes (add as you refactor):
          <Route path="/"          element={<OnboardingPage/>}/>
          <Route path="/login"     element={<LoginPage/>}/>
          <Route path="/dashboard" element={<ProtectedRoute><DashboardPage/></ProtectedRoute>}/>
          <Route path="/workouts"  element={<ProtectedRoute><WorkoutsPage/></ProtectedRoute>}/>
          <Route path="/nutrition" element={<ProtectedRoute><NutritionPage/></ProtectedRoute>}/>
          <Route path="/profile"   element={<ProtectedRoute><ProfilePage/></ProtectedRoute>}/>
          */}
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </ErrorBoundary>
);

export default App;
