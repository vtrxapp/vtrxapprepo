// routes/upload.js
const express = require('express');
const multer  = require('multer');
const upload  = require('../controllers/uploadController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Store files in memory (then upload to S3)
const memStorage = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.use(protect);
router.post('/avatar',          memStorage.single('image'), upload.uploadAvatar);
router.post('/progress-photo',  memStorage.single('image'), upload.uploadProgressPhoto);

module.exports = router;
