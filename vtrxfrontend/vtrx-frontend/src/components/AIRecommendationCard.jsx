// ─────────────────────────────────────────────────────────────────────────────
// src/components/AIRecommendationCard.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Displays an AI-generated coaching recommendation.
// Fetches from the backend which calls OpenAI.
// Shows a skeleton while loading, error state if it fails.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import api from '@/services/api';
import { Skeleton } from './LoadingSpinner';

const PRIMARY = '#00A3FF';
const FONT    = 'Montserrat, sans-serif';
const CARD    = '#141414';
const BORDER  = '#242424';

const AIRecommendationCard = ({ mood, userGoal, recentWorkouts, onExpand }) => {
  const [recommendation, setRecommendation] = useState(null);
  const [isLoading,      setIsLoading]      = useState(true);
  const [error,          setError]          = useState(null);

  useEffect(() => {
    if (!mood) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    // Fetch AI recommendation from backend
    api.post('/workouts/ai-recommendation', { mood, userGoal, recentWorkouts })
      .then(data => {
        if (!cancelled) {
          setRecommendation(data?.data?.recommendation);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setIsLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [mood, userGoal]);

  return (
    <div style={{
      background: `linear-gradient(135deg, ${CARD} 0%, #0d1a2e 100%)`,
      borderRadius: 20,
      padding: 18,
      border: `1px solid ${PRIMARY}33`,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Glow effect */}
      <div style={{
        position:'absolute', top:-30, right:-30,
        width:100, height:100,
        background: `radial-gradient(circle, ${PRIMARY}22 0%, transparent 70%)`,
        pointerEvents:'none',
      }}/>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <div style={{ width:28, height:28, borderRadius:8, background:`${PRIMARY}22`, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={PRIMARY} strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v4l3 3"/>
          </svg>
        </div>
        <span style={{ fontFamily:FONT, fontWeight:700, fontSize:11, color:PRIMARY, letterSpacing:1 }}>
          AI COACH
        </span>
      </div>

      {/* Content */}
      {isLoading ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <Skeleton height={14} width="95%"/>
          <Skeleton height={14} width="80%"/>
          <Skeleton height={14} width="60%"/>
        </div>
      ) : error ? (
        <p style={{ fontFamily:FONT, fontSize:13, color:'#888', margin:0, lineHeight:1.5 }}>
          Unable to load AI recommendation right now. Check back after your next workout.
        </p>
      ) : (
        <>
          <p style={{ fontFamily:FONT, fontSize:13, color:'#ccc', margin:'0 0 12px', lineHeight:1.6 }}>
            {recommendation}
          </p>
          {onExpand && (
            <button onClick={onExpand} style={{
              background:'none', border:`1px solid ${PRIMARY}44`,
              borderRadius:20, padding:'6px 14px',
              fontFamily:FONT, fontWeight:600, fontSize:11,
              color:PRIMARY, cursor:'pointer', letterSpacing:0.5,
            }}>
              VIEW FULL ANALYSIS →
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default AIRecommendationCard;
