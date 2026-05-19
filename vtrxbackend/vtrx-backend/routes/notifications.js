// routes/notifications.js
const express = require('express');
const notif   = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.post('/register',    notif.registerToken);
router.delete('/register',  notif.removeToken);
router.get('/',             notif.getNotifications);
router.patch('/read',       notif.markAllRead);
router.patch('/:id/read',   notif.markOneRead);
router.post('/test',        notif.sendTest);

module.exports = router;
