const express = require('express');
const user    = require('../controllers/userController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/profile',                       user.getProfile);
router.put('/profile',                       user.updateProfile);
router.post('/mood',                         user.logMood);
router.get('/progress',                      user.getProgressLogs);
router.post('/progress',                     user.logProgress);
router.get('/personal-records',              user.getPersonalRecords);
router.get('/water',                         user.getTodayWater);
router.get('/water/history',                 user.getWaterHistory);
router.post('/water',                        user.logWater);

module.exports = router;
