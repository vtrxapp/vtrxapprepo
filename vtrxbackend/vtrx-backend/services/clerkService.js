// services/clerkService.js — Clerk Authentication using REST API directly
const https = require('https');
const logger = require('../utils/logger');

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;

// Helper: Clerk REST API call
const clerkAPI = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: 'api.clerk.com',
    path:     '/v1' + path,
    method,
    headers: {
      'Authorization':  `Bearer ${CLERK_SECRET}`,
      'Content-Type':   'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    },
  };
  const req = https.request(options, res => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        if (res.statusCode >= 400) reject(parsed);
        else resolve(parsed);
      } catch(_e) { reject(new Error(raw)); }
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

const signUp = async ({ email, password, username, name }) => {
  try {
    const cleanUsername = (username || email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 15);

    const user = await clerkAPI('POST', '/users', {
      email_address: [email],
      password,
      username: cleanUsername,
      first_name: name ? name.split(' ')[0] : cleanUsername,
      last_name:  name ? name.split(' ').slice(1).join(' ') : '',
    });

    logger.info(`Clerk signUp: ${email} | id: ${user.id}`);

    const emailId = user.email_addresses?.[0]?.id;
    if (emailId) {
      try {
        await clerkAPI('POST', `/email_addresses/${emailId}/prepare_verification`, { strategy: 'email_code' });
        logger.info(`Verification email sent to: ${email}`);
      } catch(e) {
        logger.warn('Verification email send failed:', JSON.stringify(e));
      }
    }

    return { clerkUserId: user.id, emailVerification: true };
  } catch (err) {
    logger.error('Clerk signUp error:', JSON.stringify(err));
    const code = err?.errors?.[0]?.code || '';
    if (code === 'form_identifier_exists') {
      const e = new Error('Account already exists.'); e.name = 'UsernameExistsException'; throw e;
    }
    throw new Error(err?.errors?.[0]?.message || 'Signup failed');
  }
};

const confirmSignUp = async ({ email, code }) => {
  try {
    const search = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users = search.data || search;
    if (!users?.length) { const e = new Error('User not found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users[0];
    const emailAddr = user.email_addresses?.find(e => e.email_address === email);
    if (!emailAddr) { const e = new Error('Email not found.'); e.name = 'UserNotFoundException'; throw e; }

    await clerkAPI('POST', `/email_addresses/${emailAddr.id}/attempt_verification`, { code });
    logger.info(`Clerk confirmSignUp success: ${email}`);
  } catch (err) {
    logger.error('Clerk confirmSignUp error:', JSON.stringify(err));
    const errCode = err?.errors?.[0]?.code || err?.message || '';
    if (errCode.includes('incorrect') || errCode.includes('invalid') || errCode.includes('mismatch')) {
      const e = new Error('Invalid verification code.'); e.name = 'CodeMismatchException'; throw e;
    }
    if (errCode.includes('expired')) {
      const e = new Error('Code expired. Please request a new one.'); e.name = 'ExpiredCodeException'; throw e;
    }
    throw new Error(err?.errors?.[0]?.message || 'Verification failed');
  }
};

const login = async ({ email, password }) => {
  try {
    const search = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users = search.data || search;
    if (!users?.length) { const e = new Error('No account found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users[0];

    const emailAddr = user.email_addresses?.find(e => e.email_address === email);
    if (emailAddr?.verification?.status !== 'verified') {
      const e = new Error('Please verify your email before logging in. Check your inbox.');
      e.name = 'UserNotConfirmedException'; throw e;
    }

    const result = await clerkAPI('POST', `/users/${user.id}/verify_password`, { password });
    if (!result?.verified) { const e = new Error('Incorrect email or password.'); e.name = 'NotAuthorizedException'; throw e; }

    return { accessToken: user.id };
  } catch (err) {
    if (err.name) throw err;
    logger.error('Clerk login error:', JSON.stringify(err));
    throw new Error(err?.errors?.[0]?.message || 'Login failed');
  }
};

const resendConfirmationCode = async ({ email }) => {
  try {
    const search = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users = search.data || search;
    if (!users?.length) { const e = new Error('User not found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users[0];
    const emailAddr = user.email_addresses?.find(e => e.email_address === email);
    if (emailAddr) {
      await clerkAPI('POST', `/email_addresses/${emailAddr.id}/prepare_verification`, { strategy: 'email_code' });
      logger.info(`Clerk resendCode success: ${email}`);
    }
  } catch (err) {
    logger.error('Clerk resendCode error:', JSON.stringify(err));
    throw new Error(err?.errors?.[0]?.message || 'Resend failed');
  }
};

const forgotPassword = async ({ email }) => { logger.info(`Clerk forgotPassword: ${email}`); };

const confirmForgotPassword = async ({ email, code, newPassword }) => {
  try {
    const search = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users = search.data || search;
    if (!users?.length) throw new Error('UserNotFoundException');
    await clerkAPI('PATCH', `/users/${users[0].id}`, { password: newPassword });
  } catch (err) { logger.error('Clerk resetPassword error:', JSON.stringify(err)); throw err; }
};

const signOut = async ({ accessToken }) => {
  try {
    if (accessToken) await clerkAPI('DELETE', `/sessions/${accessToken}/revoke`, {});
  } catch(_e) {}
};

module.exports = { signUp, confirmSignUp, login, resendConfirmationCode, forgotPassword, confirmForgotPassword, signOut };