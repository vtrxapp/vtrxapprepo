const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 }   = require('uuid');

let _client = null;
const getClient = () => {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
};

const uploadBuffer = async ({ buffer, mimetype, bucket, path }) => {
  const { data, error } = await getClient().storage
    .from(bucket)
    .upload(path, buffer, { contentType: mimetype, upsert: true, cacheControl: '31536000' });
  if (error) throw error;
  const { data: { publicUrl } } = getClient().storage.from(bucket).getPublicUrl(data.path);
  return { url: publicUrl, key: data.path };
};

const uploadAvatar = ({ userId, buffer, mimetype }) => {
  const ext = mimetype.split('/')[1] || 'jpg';
  return uploadBuffer({ buffer, mimetype, bucket: 'avatars', path: `${userId}.${ext}` });
};

const uploadProgressPhoto = ({ userId, buffer, mimetype }) => {
  const ext = mimetype.split('/')[1] || 'jpg';
  return uploadBuffer({ buffer, mimetype, bucket: 'progress-photos', path: `${userId}/${uuidv4()}.${ext}` });
};

const deleteFile = async ({ bucket, key }) => {
  const { error } = await getClient().storage.from(bucket).remove([key]);
  if (error) throw error;
};

module.exports = { uploadAvatar, uploadProgressPhoto, uploadBuffer, deleteFile };
