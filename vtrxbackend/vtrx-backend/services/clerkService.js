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

    const emailId = user.email_addresses?.[0]?.id;
    if (emailId) {
      try {
        await clerkAPI('POST', `/email_addresses/${emailId}/prepare_verification`, {
          strategy: 'email_code',
        });
        logger.info(`Verification email triggered for ${email}`);
      } catch (e) {
        logger.warn(`Verification email send failed for ${email}`);
      }
    }

    return { clerkUserId: user.id, emailVerification: false };
  } catch (err) {
    logger.error('Clerk signUp error:', JSON.stringify(err));
    const code = err?.errors?.[0]?.code || '';
    if (code === 'form_identifier_exists') {
      const e = new Error('Account already exists.'); 
      e.name = 'UsernameExistsException'; 
      throw e;
    }
    throw new Error(err?.errors?.[0]?.message || 'Signup failed');
  }
};

// ==================== CONFIRM SIGN UP ====================
const confirmSignUp = async ({ email, code }) => {
  try {
    logger.info(`confirmSignUp START | email: ${email} | code: ${code}`);

    // Give Clerk time to propagate
    await new Promise(r => setTimeout(r, 1500));

    const search = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    logger.info(`GET /users response: ${JSON.stringify(search).slice(0, 600)}...`);

    const users = search?.data || search || [];
    if (!users.length) {
      throw new Error('User not found');
    }

    const user = users[0];
    const emailAddr = user.email_addresses?.find(e => e.email_address === email);

    if (!emailAddr) {
      throw new Error('Email address record not found');
    }

    logger.info(`Attempting verification on ID: ${emailAddr.id}`);

    const verificationResult = await clerkAPI(
      'POST', 
      `/email_addresses/${emailAddr.id}/attempt_verification`, 
      { code: String(code) }
    );

    logger.info(`✅ Verification SUCCESS: ${JSON.stringify(verificationResult)}`);
    return { success: true };

  } catch (err) {
    logger.error('=== CLERK VERIFY ERROR FULL ===');
    logger.error(JSON.stringify(err, null, 2));

    // Extract Clerk error
    let errorMessage = 'Verification failed';
    
    if (err && typeof err === 'object') {
      if (err.errors && err.errors[0]) {
        const e = err.errors[0];
        errorMessage = e.longMessage || e.message || JSON.stringify(e);
        logger.error(`Clerk Error Code: ${e.code} | Message: ${errorMessage}`);
      } else if (err.message) {
        errorMessage = err.message;
      }
    }

    // Specific handling
    const msgLower = errorMessage.toLowerCase();
    if (msgLower.includes('incorrect') || msgLower.includes('invalid') || msgLower.includes('verification_failed')) {
      const e = new Error('Invalid verification code. Please check your email and try again.');
      e.name = 'CodeMismatchException';
      throw e;
    }

    if (msgLower.includes('expired')) {
      const e = new Error('Verification code has expired. Please request a new one.');
      e.name = 'ExpiredCodeException';
      throw e;
    }

    // Final fallback
    const finalError = new Error(errorMessage);
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