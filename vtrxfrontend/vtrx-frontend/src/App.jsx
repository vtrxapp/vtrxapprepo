import { ClerkProvider, AuthenticateWithRedirectCallback } from '@clerk/clerk-react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ErrorBoundary from '@/components/ErrorBoundary';
import VTRXApp from './VTRXApp';

const CLERK_PK = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const App = () => (
  <ErrorBoundary>
    <ClerkProvider publishableKey={CLERK_PK}>
      <BrowserRouter>
        <Routes>
          {/* Google/Apple OAuth land back here after the provider's consent screen.
              This finishes the sign-in/sign-up, then redirects to "/" — VTRXApp's own
              app-boot hydration takes it from there (fetches profile, routes to
              dashboard or onboarding), same as any other sign-in. */}
          <Route path="/sso-callback" element={<AuthenticateWithRedirectCallback afterSignInUrl="/" afterSignUpUrl="/"/>}/>
          <Route path="/*" element={<VTRXApp/>}/>
        </Routes>
      </BrowserRouter>
    </ClerkProvider>
  </ErrorBoundary>
);

export default App;
