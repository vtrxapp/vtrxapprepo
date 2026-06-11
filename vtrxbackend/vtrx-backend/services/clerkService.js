// services/clerkService.js
const https = require('https');
const logger = require('../utils/logger');

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
logger.info(`CLERK_SECRET_KEY loaded: ${!!CLERK_SECRET}`);

// ── Clerk Backend API helper ───────────────────────────────────────────────────
// Uses api.clerk.com (Backend API / BAPI), authenticated with the secret key.
// The BAPI is an admin/management API — it is NOT used for session creation.
// Authentication is done by: find user → verify_password → issue our own JWT.
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

// ── Normalise Clerk user-list response ────────────────────────────────────────
// GET /v1/users returns a plain array; some endpoints wrap in { data: [] }.
const toArray = (res) => (Array.isArray(res) ? res : (res?.data || []));

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
      last_name:  name ? name.split(' ').slice(1).join(' ') : '',
      skip_password_checks: false,
    });

    logger.info(`Clerk signUp: ${email} | id: ${user.id}`);

    const emailAddr = user.email_addresses?.[0];
    let verificationId = null;

    if (emailAddr) {
      try {
        const prepareRes = await clerkAPI(
          'POST',
          `/email_addresses/${emailAddr.id}/prepare_verification`,
          { strategy: 'email_code' }
        );
        // prepareRes?.id is the email_address ID (eoa_xxx) — NOT the verification ID.
        // Only use verification?.id (ver_xxx) if Clerk returns it.
        verificationId = prepareRes?.verification?.id || null;
        logger.info(`Verification prepared for ${email} | emailAddrId: ${emailAddr.id} | verificationId: ${verificationId}`);
      } catch (e) {
        // Log the full Clerk error so it is visible in Railway logs
        logger.error(`prepare_verification FAILED for ${email}: ${JSON.stringify(e)}`);
        // verificationId stays null — frontend will show "Session expired, sign up again"
      }
    }

    return {
      clerkUserId:    user.id,
      emailVerification: emailAddr?.verification?.status === 'verified',
      emailAddressId: emailAddr?.id,
      verificationId,
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


// ==================== CONFIRM SIGN UP (email verification) ====================
const confirmSignUp = async ({ email, code, verificationId }) => {
  try {
    logger.info(`confirmSignUp: email=${email} code=${code} verificationId=${verificationId}`);

    // Find the Clerk user by email address
    const search = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users  = toArray(search);
    if (!users.length) throw new Error('User not found.');

    const user      = users[0];
    const emailAddr = user.email_addresses?.find(e => e.email_address === email);
    if (!emailAddr) throw new Error('Email address not found on this account.');

    // Try with just { code } first — the standard BAPI behavior.
    // If Clerk returns an error explicitly requiring verification_id, retry with it.
    let result;
    try {
      result = await clerkAPI(
        'POST',
        `/email_addresses/${emailAddr.id}/attempt_verification`,
        { code: String(code) }
      );
    } catch (firstErr) {
      const firstErrMsg = (firstErr?.errors?.[0]?.message || firstErr?.errors?.[0]?.longMessage || JSON.stringify(firstErr)).toLowerCase();
      logger.error(`attempt_verification (no vid) failed for ${email}: ${JSON.stringify(firstErr)}`);
      if ((firstErrMsg.includes('verification_id') || firstErrMsg.includes('verification id')) && verificationId) {
        logger.info(`Retrying attempt_verification WITH verification_id: ${verificationId}`);
        result = await clerkAPI(
          'POST',
          `/email_addresses/${emailAddr.id}/attempt_verification`,
          { code: String(code), verification_id: String(verificationId) }
        );
      } else {
        throw firstErr;
      }
    }

    if (result?.verification?.status !== 'verified') {
      logger.error(`Unexpected verification status after attempt: ${result?.verification?.status}`);
      const e = new Error('Invalid verification code.');
      e.name = 'CodeMismatchException';
      throw e;
    }

    logger.info(`✅ Email verified for ${email}`);
    return { success: true, result };
  } catch (err) {
    // Re-throw errors we already typed
    if (err.name === 'CodeMismatchException' || err.name === 'ExpiredCodeException') throw err;

    logger.error('Clerk confirmSignUp error:', JSON.stringify(err, null, 2));
    const firstError = err?.errors?.[0] || {};
    // Clerk API returns snake_case in raw JSON (long_message), JS object may have either
    const errorMsg = firstError.longMessage || firstError.long_message || firstError.message || err.message || 'Verification failed';

    // strategy_for_user_invalid: no pending verification (e.g. Clerk auto-verified in dev mode)
    // verification_already_verified: email already confirmed
    if (
      firstError.code === 'strategy_for_user_invalid' ||
      firstError.code === 'verification_already_verified' ||
      errorMsg.toLowerCase().includes('strategy')
    ) {
      // Re-check current verification status — if already verified, accept as success
      try {
        const recheck = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
        const recheckUsers = toArray(recheck);
        if (recheckUsers.length) {
          const addr = recheckUsers[0].email_addresses?.find(a => a.email_address === email);
          if (addr?.verification?.status === 'verified') {
            logger.info(`Email ${email} is already verified — treating confirmation as success`);
            return { success: true };
          }
        }
      } catch (_e) {}
      const e = new Error('No pending verification found. Please request a new code.');
      e.name = 'CodeMismatchException';
      throw e;
    }

    if (
      firstError.code === 'form_code_incorrect' ||
      errorMsg.toLowerCase().includes('incorrect') ||
      errorMsg.toLowerCase().includes('invalid')
    ) {
      const e = new Error('Invalid verification code.');
      e.name = 'CodeMismatchException';
      throw e;
    }
    if (
      firstError.code === 'form_code_expired' ||
      errorMsg.toLowerCase().includes('expired')
    ) {
      const e = new Error('Code expired. Please request a new one.');
      e.name = 'ExpiredCodeException';
      throw e;
    }

    const finalError = new Error(errorMsg || 'Verification failed. Please try again.');
    finalError.name  = 'VerificationFailedException';
    throw finalError;
  }
};


// ==================== LOGIN ====================
// Correct BAPI pattern:
//   1. GET  /v1/users?email_address=   → find the user record
//   2. POST /v1/users/{id}/verify_password → validate the password
//   3. (caller) issue a custom JWT via signToken()
//
// POST /v1/sessions does NOT accept email+password — it is a session-management
// endpoint that requires a user_id, not credentials.
const login = async ({ email, password }) => {
  try {
    logger.info(`Clerk login attempt for: ${email}`);

    // 1. Find user by email
    const searchResult = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users        = toArray(searchResult);

    if (!users.length) {
      const e = new Error('Incorrect email or password.');
      e.name  = 'NotAuthorizedException';
      throw e;
    }

    const user      = users[0];
    const emailAddr = user.email_addresses?.find(a => a.email_address === email);

    // 2. Guard: block login if email is not yet verified
    if (emailAddr && emailAddr.verification?.status !== 'verified') {
      const e = new Error('Please verify your email before logging in.');
      e.name  = 'UserNotConfirmedException';
      throw e;
    }

    // 3. Verify the password — throws 422 from Clerk on failure
    await clerkAPI('POST', `/users/${user.id}/verify_password`, { password });

    logger.info(`✅ Login successful for: ${email} (clerkId: ${user.id})`);

    return { success: true, clerkUserId: user.id };
  } catch (err) {
    // Re-throw already-typed errors without wrapping
    if (err.name === 'NotAuthorizedException' || err.name === 'UserNotConfirmedException') {
      throw err;
    }

    logger.error('Clerk login error:', JSON.stringify(err, null, 2));
    const firstError = err?.errors?.[0] || {};

    if (
      firstError.code === 'form_password_incorrect' ||
      firstError.code === 'not_found'
    ) {
      const e = new Error('Incorrect email or password.');
      e.name  = 'NotAuthorizedException';
      throw e;
    }

    // Any other Clerk error → generic auth failure (don't leak internal details)
    const e = new Error('Login failed. Please try again.');
    e.name  = 'NotAuthorizedException';
    throw e;
  }
};


// ==================== RESEND CONFIRMATION CODE ====================
const resendConfirmationCode = async ({ email }) => {
  try {
    logger.info(`Resending verification code for: ${email}`);

    const searchResult = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users        = toArray(searchResult);

    if (!users.length) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    const user      = users[0];
    const emailAddr = user.email_addresses?.find(a => a.email_address === email);

    if (!emailAddr) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    if (emailAddr.verification?.status === 'verified') {
      return { success: true, message: 'Email is already verified.' };
    }

    const prepareRes = await clerkAPI(
      'POST',
      `/email_addresses/${emailAddr.id}/prepare_verification`,
      { strategy: 'email_code' }
    );
    // prepareRes?.id is the email_address ID (eoa_xxx) — not the verification ID
    const newVerificationId = prepareRes?.verification?.id || null;

    logger.info(`Verification code resent to: ${email} | emailAddrId: ${emailAddr.id} | new verificationId: ${newVerificationId}`);
    return { success: true, verificationId: newVerificationId };
  } catch (err) {
    if (err.name === 'UserNotFoundException') throw err;

    logger.error('Resend code error:', JSON.stringify(err));
    const firstError = err?.errors?.[0] || {};

    if (firstError.code?.includes('rate_limit') || firstError.code?.includes('too_many')) {
      const e = new Error('Too many attempts. Please wait before requesting another code.');
      e.name  = 'LimitExceededException';
      throw e;
    }

    throw new Error(firstError.longMessage || 'Failed to resend verification code.');
  }
};


// ==================== FORGOT PASSWORD ====================
// Uses Clerk's email_code verification flow: prepare_verification sends a code
// to the user's email, which is then submitted in confirmForgotPassword.
// No external email service required — Clerk delivers the code.
const forgotPassword = async ({ email }) => {
  try {
    const searchResult = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users        = toArray(searchResult);

    if (!users.length) {
      // Security: never reveal whether an email is registered
      logger.info(`Password reset requested for unregistered email: ${email}`);
      return { success: true };
    }

    const user      = users[0];
    const emailAddr = user.email_addresses?.find(a => a.email_address === email);

    if (!emailAddr) {
      return { success: true };
    }

    await clerkAPI('POST', `/email_addresses/${emailAddr.id}/prepare_verification`, { strategy: 'email_code' });

    logger.info(`Password reset code sent to ${email} via Clerk`);
    return { success: true };
  } catch (err) {
    // Always return success — never reveal whether the email exists
    logger.error(`forgotPassword error for ${email}: ${JSON.stringify(err)}`);
    return { success: true };
  }
};


// ==================== CONFIRM FORGOT PASSWORD ====================
// 1. Find the user in Clerk by email
// 2. Call attempt_verification to confirm code ownership
// 3. PATCH /users/{id} to update the password
const confirmForgotPassword = async ({ email, code, newPassword }) => {
  try {
    const searchResult = await clerkAPI('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const users        = toArray(searchResult);

    if (!users.length) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    const user      = users[0];
    const emailAddr = user.email_addresses?.find(a => a.email_address === email);

    if (!emailAddr) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    // Verify the reset code — proves the requester owns the email
    const result = await clerkAPI(
      'POST',
      `/email_addresses/${emailAddr.id}/attempt_verification`,
      { code: String(code) }
    );

    if (result?.verification?.status !== 'verified') {
      const e = new Error('Invalid verification code.');
      e.name  = 'CodeMismatchException';
      throw e;
    }

    // Update the password in Clerk
    await clerkAPI('PATCH', `/users/${user.id}`, { password: newPassword });

    logger.info(`✅ Password reset successful for ${email}`);
    return { success: true };
  } catch (err) {
    if (
      err.name === 'CodeMismatchException' ||
      err.name === 'ExpiredCodeException'  ||
      err.name === 'UserNotFoundException'
    ) throw err;

    logger.error('confirmForgotPassword error:', JSON.stringify(err, null, 2));
    const firstError = err?.errors?.[0] || {};
    const errorMsg   = firstError.longMessage || firstError.long_message || firstError.message || err.message || 'Password reset failed';

    if (
      firstError.code === 'form_code_incorrect' ||
      errorMsg.toLowerCase().includes('incorrect') ||
      errorMsg.toLowerCase().includes('invalid code')
    ) {
      const e = new Error('Invalid verification code.');
      e.name  = 'CodeMismatchException';
      throw e;
    }
    if (
      firstError.code === 'form_code_expired' ||
      errorMsg.toLowerCase().includes('expired')
    ) {
      const e = new Error('Code expired. Please request a new one.');
      e.name  = 'ExpiredCodeException';
      throw e;
    }
    if (
      firstError.code?.includes('password') ||
      errorMsg.toLowerCase().includes('password')
    ) {
      const e = new Error(errorMsg || 'Password does not meet requirements.');
      e.name  = 'InvalidPasswordException';
      throw e;
    }

    throw new Error(errorMsg);
  }
};


// ==================== SIGN OUT ====================
// The app uses stateless custom JWTs — there is no Clerk session to revoke.
// Logout is effectively handled by the client deleting the JWT from localStorage.
const signOut = async ({ accessToken } = {}) => {
  logger.info('signOut called — custom JWT cleared by client');
  return { success: true };
};


module.exports = {
  signUp,
  confirmSignUp,
  login,
  resendConfirmationCode,
  forgotPassword,
  confirmForgotPassword,
  signOut,
};
