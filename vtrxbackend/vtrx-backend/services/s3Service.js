// ─────────────────────────────────────────────────────────────────────────────
// services/s3Service.js — AWS S3 File Upload Service
// ─────────────────────────────────────────────────────────────────────────────
// Handles uploading files to S3 and generating CDN URLs via CloudFront.
// Used for: progress photos, profile avatars, custom media
// ─────────────────────────────────────────────────────────────────────────────

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 }   = require('uuid');
const logger           = require('../utils/logger');

const s3 = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
});

const BUCKET       = process.env.S3_BUCKET_NAME;
const CLOUDFRONT   = process.env.CLOUDFRONT_URL;

// ── Upload a Buffer to S3 ──────────────────────────────────────────────────────
const uploadBuffer = async ({ buffer, mimetype, folder, filename }) => {
  const ext      = mimetype.split('/')[1] || 'jpg';
  const key      = `${folder}/${filename || uuidv4()}.${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimetype,
    CacheControl: 'public, max-age=31536000', // 1 year cache
  }));

  // Return CloudFront URL (faster than S3 direct)
  const url = CLOUDFRONT ? `${CLOUDFRONT}/${key}` : `https://${BUCKET}.s3.amazonaws.com/${key}`;
  logger.info(`Uploaded to S3: ${key}`);
  return { key, url };
};

// ── Delete a File from S3 ─────────────────────────────────────────────────────
const deleteFile = async (key) => {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  logger.info(`Deleted from S3: ${key}`);
};

// ── Upload Progress Photo ─────────────────────────────────────────────────────
const uploadProgressPhoto = async ({ userId, buffer, mimetype }) => {
  return uploadBuffer({
    buffer,
    mimetype,
    folder:   `progress-photos/${userId}`,
    filename: `${Date.now()}`,
  });
};

// ── Upload Profile Avatar ─────────────────────────────────────────────────────
const uploadAvatar = async ({ userId, buffer, mimetype }) => {
  return uploadBuffer({
    buffer,
    mimetype,
    folder:   `avatars`,
    filename: userId,
  });
};

// ── Generate Pre-signed URL ────────────────────────────────────────────────────
// For temporary access to private files (not needed for CloudFront public files)
const getPresignedUrl = async (key, expiresIn = 3600) => {
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
};

// ── Get CDN URL from S3 key ────────────────────────────────────────────────────
const getCdnUrl = (key) => {
  if (!key) return null;
  if (key.startsWith('http')) return key;
  return CLOUDFRONT ? `${CLOUDFRONT}/${key}` : `https://${BUCKET}.s3.amazonaws.com/${key}`;
};

module.exports = {
  uploadBuffer,
  deleteFile,
  uploadProgressPhoto,
  uploadAvatar,
  getPresignedUrl,
  getCdnUrl,
};
