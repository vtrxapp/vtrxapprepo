// ─────────────────────────────────────────────────────────────────────────────
// src/components/ErrorBoundary.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Catches JavaScript errors anywhere in the component tree.
// Without this, one error would crash the entire app.
// ─────────────────────────────────────────────────────────────────────────────

import { Component } from 'react';

const FONT = 'Montserrat, sans-serif';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // In production, send this to your error tracking service (e.g. Sentry)
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: 'fixed', inset: 0,
          background: '#0a0a0a',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: 32,
        }}>
          <div style={{ fontFamily:FONT, fontWeight:900, fontSize:20, color:'#fff', marginBottom:12 }}>
            Something went wrong
          </div>
          <div style={{ fontFamily:FONT, fontSize:13, color:'#888', textAlign:'center', marginBottom:24, maxWidth:280 }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 32px', borderRadius:50,
              background: '#00A3FF', border:'none',
              fontFamily:FONT, fontWeight:700, fontSize:14,
              color:'#fff', cursor:'pointer',
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
