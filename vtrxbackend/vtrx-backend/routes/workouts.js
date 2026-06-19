const express  = require('express');
const workout  = require('../controllers/workoutController');
const plan     = require('../controllers/workoutPlanController');
const { getRecommendations } = require('../controllers/recommendationController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// ── AI Workout Plan ───────────────────────────────────────────────────────────
router.post('/generate-plan',            plan.generatePlan);           // POST  — generate + save new 4-week plan
router.get('/active-plan',               plan.getActivePlan);          // GET   — fetch current active plan
router.patch('/active-plan/advance-week',plan.advancePlanWeek);        // PATCH — advance to next week
router.post('/exercise-log',             plan.logExercise);            // POST  — log exercise performance
router.get('/exercise-history/:exerciseName', plan.getExerciseHistory);// GET   — history for progressive overload

router.post('/generate-session',       workout.generateSessionForDay);         // POST — deterministic single-session for day-switch
router.post('/generate-daily',         workout.generateDailyWorkout);          // POST — ymove-first AI daily workout
router.get('/recommend',               getRecommendations);
router.get('/generate',                workout.generateWorkout);        // GET /workouts/generate?muscleGroup=chest&difficulty=intermediate
router.get('/program/generate',        workout.generateProgram);        // GET /workouts/program/generate?goal=muscle_building&weeks=4
router.get('/muscle-groups',           workout.getMuscleGroups);        // GET /workouts/muscle-groups
router.get('/exercise-types',          workout.getExerciseTypes);       // GET /workouts/exercise-types
router.post('/posture/analyze',        workout.analyzePosture);         // POST /workouts/posture/analyze
router.get('/ymove/usage',             workout.getYmoveUsage);          // GET /workouts/ymove/usage
router.get('/ymove/ping',              workout.ymovePing);              // GET /workouts/ymove/ping — verify API + sample video URL
router.get('/ymove/debug/:id',         workout.debugYmoveExercise);     // GET /workouts/ymove/debug/:id — raw ymove response
router.post('/ymove/sync-exercises',   workout.syncYmoveExercises);     // POST /workouts/ymove/sync-exercises
router.get('/history',                 workout.getWorkoutHistory);
router.get('/stats',                   workout.getWeeklyStats);
router.get('/video-progress',          workout.getVideoProgress);
router.get('/ai-summary/:logId',       workout.getAISummary);
router.get('/exercise-video',          workout.getExerciseVideoUrl);    // GET /workouts/exercise-video?name=Squats (name-based fallback)
router.get('/exercise-video/:ymoveId', workout.getExerciseVideoUrl);    // GET /workouts/exercise-video/:id (fast path)
router.get('/upcoming',                workout.getUpcomingWorkouts);
router.get('/schedule',                workout.getSchedule);
router.patch('/schedule/:id/move',     workout.moveScheduleEntry);
router.patch('/schedule/:id/replace',  workout.replaceScheduleEntry);
router.get('/:id',                     workout.getWorkoutById);
router.get('/',                        workout.getWorkouts);
router.post('/log',                    workout.logWorkout);
router.post('/video-progress',         workout.saveVideoProgress);

module.exports = router;
