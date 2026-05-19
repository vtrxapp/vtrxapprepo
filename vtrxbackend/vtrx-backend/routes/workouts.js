const express  = require('express');
const workout  = require('../controllers/workoutController');
const { protect, requirePremium } = require('../middleware/auth');

const router = express.Router();

// All workout routes require the user to be logged in
router.use(protect);

router.get('/',              workout.getWorkouts);
router.get('/history',       workout.getWorkoutHistory);
router.get('/stats',         workout.getWeeklyStats);
router.get('/:id',           workout.getWorkoutById);
router.post('/log',          workout.logWorkout);
router.get('/ai-summary/:logId', workout.getAISummary);

module.exports = router;
