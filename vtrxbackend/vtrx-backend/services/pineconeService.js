const { Pinecone } = require('@pinecone-database/pinecone');
const logger       = require('../utils/logger');
const { embedText, embedBatch, workoutText, recipeText } = require('./embeddingService');

const INDEX_NAME = 'vtrx';
const DIMENSION  = 1536;       // text-embedding-3-small
const METRIC     = 'cosine';

let _pc    = null;
let _index = null;

const getClient = () => {
  if (!_pc) {
    if (!process.env.PINECONE_API_KEY) {
      logger.warn('PINECONE_API_KEY not set — vector search disabled');
      return null;
    }
    _pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return _pc;
};

// ── Index bootstrap (call once on server start) ───────────────────────────────
const initIndex = async () => {
  const pc = getClient();
  if (!pc) return;
  try {
    const existing = await pc.listIndexes();
    const names    = (existing.indexes || []).map(i => i.name);
    if (!names.includes(INDEX_NAME)) {
      logger.info(`Pinecone: creating index "${INDEX_NAME}"…`);
      await pc.createIndex({
        name:      INDEX_NAME,
        dimension: DIMENSION,
        metric:    METRIC,
        spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
      });
      // Wait for index to be ready
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) {
        await new Promise(r => setTimeout(r, 4000));
        const desc = await pc.describeIndex(INDEX_NAME);
        ready = desc.status?.ready === true;
      }
      logger.info('Pinecone: index ready');
    }
    _index = pc.index(INDEX_NAME);
    logger.info(`Pinecone: connected to index "${INDEX_NAME}"`);
  } catch (err) {
    logger.error(`Pinecone init error: ${err.message}`);
  }
};

const getIndex = () => _index;

// ── Upsert helpers ────────────────────────────────────────────────────────────
const upsertWorkout = async (workout) => {
  const idx = getIndex();
  if (!idx) return;
  const vector = await embedText(workoutText(workout));
  if (!vector) return;
  await idx.namespace('workouts').upsert([{
    id:       workout.id,
    values:   vector,
    metadata: {
      name:       workout.name,
      type:       workout.type,
      difficulty: workout.difficulty || 'Intermediate',
      duration:   workout.duration,
      calories:   workout.calories || 0,
      imageUrl:   workout.imageUrl || '',
    },
  }]);
};

const upsertRecipe = async (recipe) => {
  const idx = getIndex();
  if (!idx) return;
  const vector = await embedText(recipeText(recipe));
  if (!vector) return;
  await idx.namespace('recipes').upsert([{
    id:       recipe.id,
    values:   vector,
    metadata: {
      name:      recipe.name,
      calories:  recipe.calories,
      protein:   recipe.protein,
      prepTime:  recipe.prepTime || 0,
      imageUrl:  recipe.imageUrl || '',
      tags:      (recipe.tags || []).join(','),
    },
  }]);
};

// ── Bulk seed ─────────────────────────────────────────────────────────────────
const seedWorkouts = async (workouts) => {
  const idx = getIndex();
  if (!idx || !workouts.length) return;
  logger.info(`Pinecone: seeding ${workouts.length} workouts…`);
  const texts   = workouts.map(workoutText);
  const vectors = await embedBatch(texts);
  const records = workouts
    .map((w, i) => vectors[i] ? {
      id:       w.id,
      values:   vectors[i],
      metadata: { name: w.name, type: w.type, difficulty: w.difficulty || 'Intermediate', duration: w.duration, calories: w.calories || 0, imageUrl: w.imageUrl || '' },
    } : null)
    .filter(Boolean);
  for (let i = 0; i < records.length; i += 100) {
    await idx.namespace('workouts').upsert(records.slice(i, i + 100));
  }
  logger.info(`Pinecone: seeded ${records.length} workouts`);
};

const seedRecipes = async (recipes) => {
  const idx = getIndex();
  if (!idx || !recipes.length) return;
  logger.info(`Pinecone: seeding ${recipes.length} recipes…`);
  const texts   = recipes.map(recipeText);
  const vectors = await embedBatch(texts);
  const records = recipes
    .map((r, i) => vectors[i] ? {
      id:       r.id,
      values:   vectors[i],
      metadata: { name: r.name, calories: r.calories, protein: r.protein, prepTime: r.prepTime || 0, imageUrl: r.imageUrl || '', tags: (r.tags || []).join(',') },
    } : null)
    .filter(Boolean);
  for (let i = 0; i < records.length; i += 100) {
    await idx.namespace('recipes').upsert(records.slice(i, i + 100));
  }
  logger.info(`Pinecone: seeded ${records.length} recipes`);
};

// ── Query ─────────────────────────────────────────────────────────────────────
const queryWorkouts = async (queryVector, topK = 6) => {
  const idx = getIndex();
  if (!idx) return [];
  const res = await idx.namespace('workouts').query({ vector: queryVector, topK, includeMetadata: true });
  return res.matches || [];
};

const queryRecipes = async (queryVector, topK = 6) => {
  const idx = getIndex();
  if (!idx) return [];
  const res = await idx.namespace('recipes').query({ vector: queryVector, topK, includeMetadata: true });
  return res.matches || [];
};

module.exports = { initIndex, upsertWorkout, upsertRecipe, seedWorkouts, seedRecipes, queryWorkouts, queryRecipes };
