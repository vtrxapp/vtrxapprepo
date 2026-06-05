// services/clerkService.js — Using raw HTTPS (stable, no deprecated packages)
const https = require('https');
const logger = require('../utils/logger');

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
logger.info(`CLERK_SECRET_KEY loaded: ${!!CLERK_SECRET}`);

// Helper: Clerk REST API call
const clerkAPI = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: 'api.clerk.com',
    path: '/v1' + path,
    method,
    headers: {
      'Authorization': `Bearer ${CLERK_SECRET}`,
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    },
  };

  const req = https.request(options, res => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        logger.info(`Clerk API ${method} ${path} -> ${res.statusCode}`);
        if (res.statusCode >= 400) {
          reject(parsed);
        } else {
          resolve(parsed);
        }
      } catch (_e) {
        reject(new Error(raw));
      }
    });
  });

  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

// ==================== SIGN UP ====================
// ==================== SIGN UP ====================
const signUp = async ({ email, password, username, name }) => {
  try {
    const cleanUsername = (username || email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 15);

    const user = await clerkAPI('POST', '/users', {
      email_address: [email],
      password,
      username: cleanUsername,
      first_name: name ? name.split(' ')[0] : cleanUsername,
      last_name: name ? name.split(' ').slice(1).join(' ') : '',
    });

    logger.info(`Clerk signUp: ${email} | id: ${user.id}`);

    const emailAddr = user.email_addresses?.[0];
    let verificationId = null;

    if (emailAddr) {
      try {
        const prepareRes = await clerkAPI('POST', `/email_addresses/${emailAddr.id}/prepare_verification`, {
          strategy: 'email_code',
        });

        // Capture verification_id from prepare response
        verificationId = prepareRes?.verification?.id || prepareRes?.id;
        
        logger.info(`Verification prepared for ${email} | verificationId: ${verificationId}`);
      } catch (e) {
        logger.warn(`Prepare verification failed: ${JSON.stringify(e)}`);
      }
    }

    return { 
      clerkUserId: user.id, 
      emailVerification: false,
      emailAddressId: emailAddr?.id,
      verificationId   // ← Return this so frontend can pass it later if needed
    };
  } catch (err) {
    logger.error('Clerk signUp error:', JSON.stringify(err));
    const code = err?.errors?.[0]?.code || '';
    if (code === 'form_identifier_exists') {
      const e = new Error('Account already exists.'); 
      e.name = 'UsernameExistsException'; 
      throw e;
    }
    throw new Error(err?.errors?.[0]?.longMessage || 'Signup failed');
  }
};

// ==================== CONFIRM SIGN UP ====================
const confirmSignUp = async ({ email, code, verificationId }) => {   // ← Accept verificationId
  try {
    logger.info(`confirmSignUp called with email: ${email} code: ${code} verificationId: ${verificationId}`);

    await new Promise(r => setTimeout(r, 1000));

    const search = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users = search.data || search || [];
    if (!users.length) throw new Error('User not found.');

    const user = users[0];
    const emailAddr = user.email_addresses?.find(e => e.email_address === email);
    if (!emailAddr) throw new Error('Email not found.');

    const emailAddressId = emailAddr.id;

    // Use verification_id if available, otherwise fallback
    const payload = { code: String(code) };
    if (verificationId) {
      payload.verification_id = verificationId;
    }

    logger.info(`Attempting verification with payload: ${JSON.stringify(payload)}`);

    await clerkAPI('POST', `/email_addresses/${emailAddressId}/attempt_verification`, payload);

    logger.info(`✅ Verification SUCCESS for ${email}`);
    return { success: true };

  } catch (err) {
    logger.error('=== CLERK VERIFY ERROR FULL ===');
    logger.error(JSON.stringify(err, null, 2));

    const firstError = err?.errors?.[0] || {};
    const errorMsg = firstError.longMessage || firstError.message || err.message || 'Verification failed';

    logger.error(`Clerk Error: ${firstError.code} | ${errorMsg}`);

    if (errorMsg.toLowerCase().includes('incorrect') || errorMsg.toLowerCase().includes('invalid')) {
      const e = new Error('Invalid verification code.');
      e.name = 'CodeMismatchException';
      throw e;
    }
    if (errorMsg.toLowerCase().includes('expired')) {
      const e = new Error('Code expired. Please request a new one.');
      e.name = 'ExpiredCodeException';
      throw e;
    }

    const finalError = new Error(errorMsg);
    finalError.name = 'VerificationFailedException';
    throw finalError;
  }
};
   

// Keep other functions as before (or update similarly if needed)
const login = async ({ email, password }) => { /* your original login */ };
const resendConfirmationCode = async ({ email }) => { /* your original */ };
const forgotPassword = async ({ email }) => { logger.info(`Clerk forgotPassword: ${email}`); };
const confirmForgotPassword = async ({ email, code, newPassword }) => { /* your original */ };
const signOut = async ({ accessToken }) => { /* your original */ };

module.exports = { 
  signUp, 
  confirmSignUp, 
  login, 
  resendConfirmationCode, 
  forgotPassword, 
  confirmForgotPassword, 
  signOut 
};