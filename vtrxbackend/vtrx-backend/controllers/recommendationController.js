const prisma   = require('../config/database');
const logger   = require('../utils/logger');
const { embedText, userText } = require('../services/embeddingService');
const { queryWorkouts, queryRecipes } = require('../services/pineconeService');

// GET /api/recommendations?type=workouts|recipes|all
const getRecommendations = async (req, res) => {
  const { type = 'all' } = req.query;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorised' });

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Build preference text from user profile and recent activity
    const recentLogs = await prisma.workoutLog.findMany({
      where:   { userId },
      orderBy: { completedAt: 'desc' },
      take:    5,
      select:  { name: true, type: true },
    });
    const recentNames = recentLogs.map(l => l.name).join(' ');
    const preferenceText = [userText(user), recentNames ? `recently did: ${recentNames}` : ''].join(' ').trim();

    const queryVector = await embedText(preferenceText);
    if (!queryVector) {
      return res.status(503).json({ success: false, message: 'Embedding service unavailable' });
    }

    const [workoutMatches, recipeMatches] = await Promise.all([
      type === 'recipes' ? [] : queryWorkouts(queryVector, 6),
      type === 'workouts' ? [] : queryRecipes(queryVector, 6),
    ]);

    // Fetch full DB records for matched IDs
    const [workouts, recipes] = await Promise.all([
      workoutMatches.length
        ? prisma.workout.findMany({ where: { id: { in: workoutMatches.map(m => m.id) } } })
        : [],
      recipeMatches.length
        ? prisma.recipe.findMany({ where: { id: { in: recipeMatches.map(m => m.id) } } })
        : [],
    ]);

    // Preserve Pinecone score ordering
    const scoreMap = Object.fromEntries([...workoutMatches, ...recipeMatches].map(m => [m.id, m.score]));
    const sortById = (arr, matches) =>
      matches.map(m => arr.find(r => r.id === m.id)).filter(Boolean)
             .map(r => ({ ...r, relevanceScore: parseFloat((scoreMap[r.id] || 0).toFixed(4)) }));

    res.json({
      success: true,
      data: {
        workouts: sortById(workouts, workoutMatches),
        recipes:  sortById(recipes,  recipeMatches),
        meta: { basedOn: { goal: user.goal, fitnessLevel: user.fitnessLevel, recentWorkouts: recentNames || null } },
      },
    });
  } catch (err) {
    logger.error(`getRecommendations error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch recommendations' });
  }
};

module.exports = { getRecommendations };
