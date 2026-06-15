const express    = require('express');
const router     = express.Router();
const { sendWelcome, tagPremium, sendNotification } = require('../controllers/n8nController');

// These routes are called by n8n workflows, secured by X-N8N-SECRET header
router.post('/send-welcome',       sendWelcome);
router.post('/tag-premium',        tagPremium);
router.post('/send-notification',  sendNotification);

module.exports = router;
