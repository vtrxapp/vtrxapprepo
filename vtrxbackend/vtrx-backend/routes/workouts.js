const express  = require('express');
const workout  = require('../controllers/workoutController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/recommend',               workout.getRecommendation);
router.get('/history',                 workout.getWorkoutHistory);
router.get('/stats',                   workout.getWeeklyStats);
router.get('/video-progress',          workout.getVideoProgress);
router.get('/ai-summary/:logId',       workout.getAISummary);
router.get('/exercise-video/:ymoveId', workout.getExerciseVideoUrl);
router.get('/:id',                     workout.getWorkoutById);
router.get('/',                        workout.getWorkouts);
router.post('/log',                    workout.logWorkout);
router.post('/video-progress',         workout.saveVideoProgress);

module.exports = router;
