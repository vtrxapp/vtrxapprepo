// Seed Pinecone with all existing workouts and recipes.
// Runs on server startup — skips gracefully if Pinecone/OpenAI not configured.
const prisma  = require('../config/database');
const logger  = require('../utils/logger');
const pine    = require('../services/pineconeService');

const run = async () => {
  if (!process.env.PINECONE_API_KEY || !process.env.OPENAI_API_KEY) {
    logger.info('Pinecone seed skipped — PINECONE_API_KEY or OPENAI_API_KEY not set');
    return;
  }

  await pine.initIndex();

  const [workouts, recipes] = await Promise.all([
    prisma.workout.findMany({ include: { exercises: { include: { exercise: true } } } }),
    prisma.recipe.findMany(),
  ]);

  await Promise.all([
    pine.seedWorkouts(workouts),
    pine.seedRecipes(recipes),
  ]);
};

module.exports = { run };
