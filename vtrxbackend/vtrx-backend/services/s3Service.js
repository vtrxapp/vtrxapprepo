const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 }   = require('uuid');
const logger           = require('../utils/logger');

// Lazy init
let s3 = null;
const getS3 = () => {
  if (!s3) {
    s3 = new S3Client({
      region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    });
  }
  return s3;
};

const BUCKET     = process.env.S3_BUCKET_NAME;
const CLOUDFRONT = process.env.CLOUDFRONT_URL;

const uploadBuffer = async ({ buffer, mimetype, folder, filename }) => {
  if (!BUCKET) throw new Error('S3_BUCKET_NAME not configured');
  const ext = mimetype.split('/')[1] || 'jpg';
  const key = `${folder}/${filename || uuidv4()}.${ext}`;
  await getS3().send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer,
    ContentType: mimetype, CacheControl: 'public, max-age=31536000',
  }));
  return { url: CLOUDFRONT ? `${CLOUDFRONT}/${key}` : `https://${BUCKET}.s3.amazonaws.com/${key}`, key };
};

const uploadAvatar = async ({ userId, buffer, mimetype }) =>
  uploadBuffer({ buffer, mimetype, folder: 'avatars', filename: userId });

const deleteFile = async ({ key }) => {
  if (!BUCKET) return;
  await getS3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
};

const getPresignedUrl = async ({ key, expiresIn = 3600 }) => {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(getS3(), cmd, { expiresIn });
};

module.exports = { uploadBuffer, uploadAvatar, deleteFile, getPresignedUrl };
