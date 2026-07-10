// ─────────────────────────────────────────────────────────────────────────────
// controllers/aiController.js — AI Coaching Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const aiService    = require('../services/aiService');
const notifService = require('../services/notificationService');
const prisma       = require('../config/database');
const logger       = require('../utils/logger');

// ── Strip stray markdown from AI prose (headings, bold/italic, list markers) ──
const stripMarkdown = (text) => {
  if (!text) return text;
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/`{1,3}/g, '')
    .trim();
};

// ── Guarantee a "Hi {name}," opener with the name mentioned exactly once ─────
// Strips every occurrence the model wrote (title-style openers, mid-text
// repeats) and prepends one canonical greeting. This makes the saved text
// immune to the name-repetition staleness check below — without it, a model
// response that keeps repeating the name would re-trigger regeneration on
// every app open instead of generating once and caching.
const ensureGreeting = (text, firstName) => {
  if (!text) return text;
  const name = firstName || 'there';
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let body = text.trim().replace(/\s+/g, ' ');
  body = body.replace(new RegExp(`^hi\\s+${safeName}\\b[,!.]?\\s*`, 'i'), '');
  body = body
    .replace(new RegExp(`\\b${safeName}\\b`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[,.\s]+/, '')
    .trim();

  return `Hi ${name}, ${body}`;
};

// ── POST /api/ai/mood-recommendation ─────────────────────────────────────────
const getMoodRecommendation = async (req, res) => {
  const { mood, notes } = req.body;

  if (!mood) {
    return res.status(400).json({ success: false, message: 'Mood is required' });
  }

  try {
    // Log the mood
    await prisma.moodLog.create({
      data: { userId: req.user.id, mood, notes },
    });

    // Get recent workout names for context
    const recentLogs = await prisma.workoutLog.findMany({
      where:   { userId: req.user.id },
      orderBy: { completedAt: 'desc' },
      take:    5,
      select:  { name: true },
    });

    // Get user data for personalised response
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { goal: true, daysPerWeek: true, streakDays: true },
    });

    const { recommendation, tokensUsed } = await aiService.generateMoodRecommendation({
      mood,
      userGoal:       user?.goal,
      recentWorkouts: recentLogs.map(l => l.name),
      daysPerWeek:    user?.daysPerWeek,
      streakDays:     user?.streakDays,
    });

    res.json({
      success: true,
      data:    { recommendation, mood, tokensUsed },
    });
  } catch (err) {
    logger.error('getMoodRecommendation error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate recommendation' });
  }
};

// ── GET /api/ai/weekly-insight ─────────────────────────────────────────────
const getWeeklyInsight = async (req, res) => {
  try {
    const weekAgo     = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [thisWeek, lastWeek, user] = await Promise.all([
      prisma.workoutLog.findMany({
        where: { userId: req.user.id, completedAt: { gte: weekAgo } },
        select: { duration: true, caloriesBurned: true },
      }),
      prisma.workoutLog.findMany({
        where: { userId: req.user.id, completedAt: { gte: twoWeeksAgo, lt: weekAgo } },
        select: { duration: true, caloriesBurned: true },
      }),
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: { goal: true, streakDays: true },
      }),
    ]);

    const weeklyStats = {
      workouts:      thisWeek.length,
      totalMinutes:  thisWeek.reduce((s, l) => s + l.duration, 0),
      totalCalories: thisWeek.reduce((s, l) => s + (l.caloriesBurned || 0), 0),
    };

    const previousWeek = {
      workouts:      lastWeek.length,
      totalMinutes:  lastWeek.reduce((s, l) => s + l.duration, 0),
      totalCalories: lastWeek.reduce((s, l) => s + (l.caloriesBurned || 0), 0),
    };

    const { insight, tokensUsed } = await aiService.generateWeeklyInsight({
      weeklyStats,
      previousWeek,
      userGoal:   user?.goal,
      streakDays: user?.streakDays,
    });

    res.json({
      success: true,
      data:    { insight, weeklyStats, previousWeek, tokensUsed },
    });
  } catch (err) {
    logger.error('getWeeklyInsight error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate insight' });
  }
};

// ── POST /api/ai/nutrition-advice ─────────────────────────────────────────────
const getNutritionAdvice = async (req, res) => {
  const { mood } = req.body;

  try {
    const [user, todayLog] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: { goal: true },
      }),
      prisma.workoutLog.findFirst({
        where: {
          userId:      req.user.id,
          completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
        select: { name: true, caloriesBurned: true },
      }),
    ]);

    const { advice, tokensUsed } = await aiService.generateNutritionAdvice({
      mood,
      userGoal:       user?.goal,
      todayWorkout:   todayLog?.name,
      caloriesBurned: todayLog?.caloriesBurned,
    });

    res.json({ success: true, data: { advice, tokensUsed } });
  } catch (err) {
    logger.error('getNutritionAdvice error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate nutrition advice' });
  }
};

// ── POST /api/ai/workout-plan ─────────────────────────────────────────────────
// Premium only — generates a personalised programme
const generatePlan = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { goal: true, fitnessLevel: true, daysPerWeek: true, equipment: true, location: true },
    });

    const { plan, tokensUsed } = await aiService.generateWorkoutPlan({
      goal:         user?.goal,
      fitnessLevel: user?.fitnessLevel,
      daysPerWeek:  user?.daysPerWeek,
      equipment:    user?.equipment,
      location:     user?.location,
    });

    res.json({ success: true, data: { plan, tokensUsed } });
  } catch (err) {
    logger.error('generatePlan error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate plan' });
  }
};

// ── POST /api/ai/recovery ─────────────────────────────────────────────────────
const getRecoveryAdvice = async (req, res) => {
  const { mood, sleepHours } = req.body;

  try {
    const [recentLogs, user] = await Promise.all([
      prisma.workoutLog.findMany({
        where:   { userId: req.user.id },
        orderBy: { completedAt: 'desc' },
        take:    5,
        select:  { name: true },
      }),
      prisma.user.findUnique({
        where:  { id: req.user.id },
        select: { streakDays: true },
      }),
    ]);

    const { advice, tokensUsed } = await aiService.generateRecoveryAdvice({
      recentWorkouts: recentLogs.map(l => l.name),
      streakDays:     user?.streakDays,
      mood,
      sleepHours,
    });

    res.json({ success: true, data: { advice, tokensUsed } });
  } catch (err) {
    logger.error('getRecoveryAdvice error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate recovery advice' });
  }
};

// ── GET /api/ai/onboarding-analysis ──────────────────────────────────────────
const getOnboardingAnalysis = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        name: true,
        aiWorkoutSummary: true,
        aiNutritionSummary: true,
        onboardingAnalysisReady: true,
      },
    });
    const firstName = user?.name?.split(' ')[0] || 'there';
    res.json({
      success: true,
      data: {
        workoutSummary:   ensureGreeting(stripMarkdown(user?.aiWorkoutSummary),   firstName) || null,
        nutritionSummary: ensureGreeting(stripMarkdown(user?.aiNutritionSummary), firstName) || null,
        ready:            user?.onboardingAnalysisReady || false,
      },
    });
  } catch (err) {
    logger.error('getOnboardingAnalysis error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch analysis' });
  }
};

// Policy: exactly ONE free AI analysis generation per new user (workout +
// nutrition summary together count as one generation event) — generate once,
// cache forever, never re-bill Claude on repeat app opens. isStale below only
// re-triggers for a genuine quality defect (missing data, stray markdown, a
// repeated name), never just because the user reopened a screen.
// This in-process lock stops a second concurrent request (e.g. the user opens
// both the Nutrition tab and VTRX Analysis within the same few seconds, before
// the first generation finishes and onboardingAnalysisReady flips true) from
// kicking off a duplicate Claude generation for the same user.
const onboardingGenerationInFlight = new Set();

// ── POST /api/ai/onboarding-analysis ─────────────────────────────────────────
const generateOnboardingAnalysis = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        name: true, goal: true, fitnessLevel: true, daysPerWeek: true,
        equipment: true, location: true, sessionDuration: true,
        preferredStyles: true, weight: true, height: true, gender: true, age: true,
        nutritionGoal: true, dietaryRestrictions: true, mealsPerDay: true,
        dailyCalorieTarget: true, goalWeightLbs: true,
        onboardingAnalysisReady: true,
        aiWorkoutSummary: true, aiNutritionSummary: true,
      },
    });

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Self-heal: force a fresh regeneration if either summary is missing, still
    // carries markdown artifacts from before prompts required plain prose, or
    // repeats the user's name (a sign of a title-style opener colliding with
    // our prepended "Hi {name}," greeting).
    const hasMarkdownArtifacts = (text) => !!text && /(\*\*|^#{1,6}\s|^[-*+]\s|^\d+\.\s)/m.test(text);
    const firstName = user.name?.split(' ')[0];
    const hasNameRepetition = (text) => {
      if (!text || !firstName) return false;
      const safeName = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = text.match(new RegExp(`\\b${safeName}\\b`, 'gi'));
      return (matches?.length || 0) > 1;
    };
    const isStale = !user.aiNutritionSummary || !user.aiWorkoutSummary
      || hasMarkdownArtifacts(user.aiNutritionSummary) || hasMarkdownArtifacts(user.aiWorkoutSummary)
      || hasNameRepetition(user.aiNutritionSummary) || hasNameRepetition(user.aiWorkoutSummary);

    if (user.onboardingAnalysisReady && !isStale) {
      return res.json({ success: true, data: { cached: true } });
    }

    if (onboardingGenerationInFlight.has(req.user.id)) {
      return res.json({ success: true, data: { generating: true } });
    }
    onboardingGenerationInFlight.add(req.user.id);

    // Schedule the notification for 5 min from now (persisted before generation)
    await prisma.user.update({
      where: { id: req.user.id },
      data: { onboardingNotifyAt: new Date(Date.now() + 5 * 60 * 1000) },
    });

    // Acknowledge immediately so frontend isn't blocked
    res.json({ success: true, data: { generating: true } });

    // Generate both summaries in background
    setImmediate(async () => {
      try {
        const { getAnthropicClient } = require('../services/anthropicClient');
        const client = getAnthropicClient();
        if (!client) return;

        const name        = user.name?.split(' ')[0] || 'there';
        const equipment   = (user.equipment || []).join(', ') || 'bodyweight';
        const styles      = (user.preferredStyles || []).join(', ') || 'general fitness';
        const restrictions= (user.dietaryRestrictions || []).join(', ') || 'none';
        const goalLabel   = {
          lose_fat:       'lose fat',
          build_muscle:   'build muscle',
          maintain:       'maintain weight',
          eat_clean:      'eat clean',
          improve_energy: 'improve energy',
        }[user.nutritionGoal] || user.nutritionGoal || 'improve fitness';

        const [workoutRes, nutritionRes] = await Promise.all([
          client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            system: 'You are VTRX AI Coach — a world-class personal trainer. Write in a warm, direct, motivating tone. Be specific to the user\'s profile. Avoid generic clichés. Respond in plain prose only — never use markdown syntax (no **bold**, no # headings, no bullet/numbered lists, no asterisks of any kind).',
            messages: [{
              role: 'user',
              content: `Write a personalised onboarding fitness analysis for ${name}.

Profile:
- Goal: ${user.goal || 'General fitness'}
- Fitness level: ${user.fitnessLevel || 'Beginner'}
- Training days/week: ${user.daysPerWeek || 3}
- Equipment: ${equipment}
- Location: ${user.location || 'Home'}
- Session duration: ${user.sessionDuration || '30-45 min'}
- Preferred styles: ${styles}
${user.weight ? `- Current weight: ${user.weight} kg` : ''}
${user.height ? `- Height: ${user.height}` : ''}
${user.gender ? `- Gender: ${user.gender}` : ''}
${user.age ? `- Age: ${user.age}` : ''}

Write 2-3 paragraphs (max 220 words) that:
1. Start with the exact greeting "Hi ${name}," then summarise their training approach based on their goal and level
2. Describe what their weekly plan will look like (days, intensity, style)
3. End with one specific, motivating insight about their chosen goal

Be specific, not generic. Don't say "great choice" or "you've got this". Plain prose only — no markdown, no **asterisks**, no headings, no lists. Do NOT open with a title or label (e.g. "Your Plan for X") before the greeting — the very first three words of your reply must be "Hi ${name}," with nothing before them. Mention "${name}" exactly once in the entire response — in that opening greeting — and never repeat their name again.`,
            }],
          }),
          client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system: 'You are VTRX Nutrition Coach. Write practical, specific nutrition guidance. No generic advice. Respond in plain prose only — never use markdown syntax (no **bold**, no # headings, no bullet/numbered lists, no asterisks of any kind).',
            messages: [{
              role: 'user',
              content: `Write a personalised nutrition overview for ${name}.

Profile:
- Nutrition goal: ${goalLabel}
- Dietary restrictions: ${restrictions}
- Meals per day: ${user.mealsPerDay || '3'}
${user.weight ? `- Current weight: ${user.weight} kg` : ''}
${user.goalWeightLbs ? `- Goal weight: ${user.goalWeightLbs} lbs` : ''}
${user.dailyCalorieTarget ? `- Daily calorie target: ${Math.round(user.dailyCalorieTarget)} kcal` : ''}

Write 2 paragraphs (max 160 words):
1. Start with the exact greeting "Hi ${name}," then explain their personalised nutrition approach for ${goalLabel}
2. Give 2-3 specific, actionable food tips for their goal and restrictions

Be practical. Use real foods, not abstractions. Plain prose only — no markdown, no **asterisks**, no headings, no lists. Do NOT open with a title or label (e.g. "Your Nutrition Plan for X") before the greeting — the very first three words of your reply must be "Hi ${name}," with nothing before them. Mention "${name}" exactly once in the entire response — in that opening greeting — and never repeat their name again.`,
            }],
          }),
        ]);

        const workoutSummary   = ensureGreeting(stripMarkdown(workoutRes.content[0].text?.trim()),   name) || '';
        const nutritionSummary = ensureGreeting(stripMarkdown(nutritionRes.content[0].text?.trim()), name) || '';

        await prisma.user.update({
          where: { id: req.user.id },
          data: {
            aiWorkoutSummary:        workoutSummary,
            aiNutritionSummary:      nutritionSummary,
            onboardingAnalysisReady: true,
          },
        });

        logger.info(`Onboarding analysis generated for user ${req.user.id}`);
      } catch (genErr) {
        logger.error('Onboarding analysis generation error:', genErr.message);
      } finally {
        onboardingGenerationInFlight.delete(req.user.id);
      }
    });

  } catch (err) {
    // Defensive: release the lock if it was taken but we threw before
    // setImmediate's own finally could ever run (e.g. the onboardingNotifyAt
    // update below it failed) — otherwise this user could never generate
    // their free summary again.
    if (req.user?.id) onboardingGenerationInFlight.delete(req.user.id);
    logger.error('generateOnboardingAnalysis error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed' });
  }
};

module.exports = {
  getMoodRecommendation,
  getWeeklyInsight,
  getNutritionAdvice,
  generatePlan,
  getRecoveryAdvice,
  getOnboardingAnalysis,
  generateOnboardingAnalysis,
};
