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
router.get('/notifications',                 user.getNotifications);
router.patch('/notifications/read',          user.markNotificationsRead);

module.exports = router;

router.post('/water', (req,res,next)=>{ require('../controllers/userController').logWater(req,res,next); });
