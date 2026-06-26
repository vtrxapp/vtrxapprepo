import { ClerkProvider } from '@clerk/clerk-react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import ErrorBoundary from '@/components/ErrorBoundary';
import VTRXApp from './VTRXApp';

const CLERK_PK = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const App = () => (
  <ErrorBoundary>
    <ClerkProvider publishableKey={CLERK_PK}>
      <BrowserRouter>
        <Routes>
          <Route path="/*" element={<VTRXApp/>}/>
        </Routes>
      </BrowserRouter>
    </ClerkProvider>
  </ErrorBoundary>
);

export default App;
