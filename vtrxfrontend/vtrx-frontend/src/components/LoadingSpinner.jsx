// ─────────────────────────────────────────────────────────────────────────────
// src/components/LoadingSpinner.jsx
// ─────────────────────────────────────────────────────────────────────────────

const PRIMARY = '#00A3FF';
const FONT    = 'Montserrat, sans-serif';

export const LoadingSpinner = ({ size = 32, color = PRIMARY, message }) => (
  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, padding:24 }}>
    <div style={{
      width:  size,
      height: size,
      border: `3px solid rgba(255,255,255,0.1)`,
      borderTop: `3px solid ${color}`,
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    }}/>
    {message && <p style={{ fontFamily:FONT, fontSize:13, color:'#888', margin:0 }}>{message}</p>}
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// src/components/SkeletonLoader.jsx — Animated placeholder while data loads
// ─────────────────────────────────────────────────────────────────────────────
export const Skeleton = ({ width = '100%', height = 16, borderRadius = 8, style = {} }) => (
  <>
    <div style={{
      width, height, borderRadius,
      background: 'linear-gradient(90deg, #1a1a1a 25%, #222 50%, #1a1a1a 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s infinite',
      ...style,
    }}/>
    <style>{`@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }`}</style>
  </>
);

// Card skeleton — mimics a workout/recipe card loading
export const CardSkeleton = () => (
  <div style={{ background:'#141414', borderRadius:18, padding:16, marginBottom:12 }}>
    <Skeleton height={120} borderRadius={12} style={{ marginBottom:12 }}/>
    <Skeleton height={18} width="70%" style={{ marginBottom:8 }}/>
    <Skeleton height={14} width="45%"/>
  </div>
);

export default LoadingSpinner;
