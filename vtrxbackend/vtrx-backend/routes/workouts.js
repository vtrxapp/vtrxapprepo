const express  = require('express');
const workout  = require('../controllers/workoutController');
const { getRecommendations } = require('../controllers/recommendationController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/recommend',               getRecommendations);  // Pinecone-powered personalised recommendations
router.get('/history',                 workout.getWorkoutHistory);
router.get('/stats',                   workout.getWeeklyStats);
router.get('/video-progress',          workout.getVideoProgress);
router.get('/ai-summary/:logId',       workout.getAISummary);
router.get('/exercise-video/:ymoveId', workout.getExerciseVideoUrl);
router.get('/upcoming',        workout.getUpcomingWorkouts);
router.get('/schedule',                    workout.getSchedule);
router.patch('/schedule/:id/move',         workout.moveScheduleEntry);
router.patch('/schedule/:id/replace',      workout.replaceScheduleEntry);
router.get('/:id',                     workout.getWorkoutById);
router.get('/',                        workout.getWorkouts);
router.post('/log',                    workout.logWorkout);
router.post('/video-progress',         workout.saveVideoProgress);

module.exports = router;
