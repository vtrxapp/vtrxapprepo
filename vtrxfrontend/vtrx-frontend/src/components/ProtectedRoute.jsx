// ─────────────────────────────────────────────────────────────────────────────
// src/components/ProtectedRoute.jsx — Route Guard
// ─────────────────────────────────────────────────────────────────────────────
// Wraps any page that requires the user to be logged in.
// If not logged in: redirect to home (onboarding/login).
// If still loading auth: show nothing (avoid flash of wrong content).
//
// Usage in router:
//   <Route path="/dashboard" element={<ProtectedRoute><Dashboard/></ProtectedRoute>}/>
// ─────────────────────────────────────────────────────────────────────────────

import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  // Still checking if user is logged in — show nothing
  if (isLoading) return null;

  // Not logged in — send to home
  if (!isAuthenticated) return <Navigate to="/" replace />;

  return children;
};

export default ProtectedRoute;
