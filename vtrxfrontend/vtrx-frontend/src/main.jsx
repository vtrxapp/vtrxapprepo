import * as Sentry from "@sentry/react";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false }),
  ],
  tracesSampleRate: 0.2,       // 20% of transactions captured for performance
  replaysSessionSampleRate: 0, // session replays off by default (bandwidth cost)
  replaysOnErrorSampleRate: 1, // always capture a replay when an error occurs
  environment: import.meta.env.MODE,
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={
      <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0a0a0a",color:"#fff",fontFamily:"'Montserrat',sans-serif",gap:12,padding:24,textAlign:"center" }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div style={{ fontWeight:800,fontSize:18 }}>Something went wrong</div>
        <div style={{ fontSize:13,color:"#888",maxWidth:280 }}>The error has been reported. Try refreshing the page.</div>
        <button onClick={()=>window.location.reload()} style={{ marginTop:8,padding:"10px 24px",borderRadius:50,background:"#00A3FF",border:"none",color:"#fff",fontFamily:"inherit",fontWeight:700,fontSize:13,cursor:"pointer" }}>Refresh</button>
      </div>
    }>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>
);
