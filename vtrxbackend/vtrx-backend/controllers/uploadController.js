// ─────────────────────────────────────────────────────────────────────────────
// controllers/uploadController.js — File Upload Controller
// ─────────────────────────────────────────────────────────────────────────────

const storageService = require('../services/supabaseStorageService');
const prisma         = require('../config/database');
const logger         = require('../utils/logger');

// ── POST /api/upload/avatar ───────────────────────────────────────────────────
const uploadAvatar = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  try {
    const { url } = await storageService.uploadAvatar({
      userId:   req.user.id,
      buffer:   req.file.buffer,
      mimetype: req.file.mimetype,
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data:  { avatarUrl: url },
    });

    res.json({ success: true, data: { avatarUrl: url } });
  } catch (err) {
    logger.error('Upload avatar error:', err);
    res.status(500).json({ success: false, message: 'Failed to upload avatar' });
  }
};

// ── POST /api/upload/progress-photo ───────────────────────────────────────────
const uploadProgressPhoto = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  try {
    const { url, key } = await storageService.uploadProgressPhoto({
      userId:   req.user.id,
      buffer:   req.file.buffer,
      mimetype: req.file.mimetype,
    });

    // Save the photo reference in progress logs
    const log = await prisma.progressLog.create({
      data: {
        userId:   req.user.id,
        photoUrl: url,
        notes:    req.body.notes || null,
      },
    });

    res.status(201).json({ success: true, data: { photoUrl: url, log } });
  } catch (err) {
    logger.error('Upload progress photo error:', err);
    res.status(500).json({ success: false, message: 'Failed to upload photo' });
  }
};

module.exports = { uploadAvatar, uploadProgressPhoto };
