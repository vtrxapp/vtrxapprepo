// services/clerkService.js
// Auth via Clerk BAPI. Uses @clerk/backend SDK for user CRUD and password
// verification. Email verification uses raw HTTPS because the SDK's EmailAddress
// API does not expose prepareVerification/attemptVerification.
const { createClerkClient } = require('@clerk/backend');
const https   = require('https');
const logger  = require('../utils/logger');

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
logger.info(`CLERK_SECRET_KEY loaded: ${!!CLERK_SECRET} | starts with: ${CLERK_SECRET?.slice(0,8)}`);

if (!CLERK_SECRET) {
  logger.error('FATAL: CLERK_SECRET_KEY is not set — all auth operations will fail');
}

const clerk = createClerkClient({ secretKey: CLERK_SECRET });

// ── Raw HTTPS helper (for BAPI endpoints not in the SDK) ──────────────────────
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
        logger.info(`Clerk BAPI ${method} ${path} -> ${res.statusCode}`);
        if (res.statusCode >= 400) reject(parsed);
        else resolve(parsed);
      } catch (_e) {
        reject(new Error(`Clerk non-JSON response: ${raw.slice(0, 200)}`));
      }
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

// ── Find a Clerk user by email (SDK) ─────────────────────────────────────────
const findByEmail = async (email) => {
  const res   = await clerk.users.getUserList({ emailAddress: [email] });
  const users = res?.data ?? res ?? [];
  return users[0] ?? null;
};

// ── Attempt email verification with fallback strategy ─────────────────────────
// Clerk's BAPI attempt_verification sometimes requires verification_id.
// The verification.id is not reliably returned by prepare_verification, so we
// try multiple approaches in order until one succeeds or all are exhausted.
const attemptEmailVerification = async (emailAddressId, code, verificationId) => {
  const endpoint = `/email_addresses/${emailAddressId}/attempt_verification`;

  // Pass 1: standard BAPI — just the code
  try {
    logger.info(`attempt_verification pass 1 (code only) for emailAddrId: ${emailAddressId}`);
    return await clerkAPI('POST', endpoint, { code: String(code) });
  } catch (err1) {
    const msg1 = (err1?.errors?.[0]?.message || err1?.errors?.[0]?.longMessage || JSON.stringify(err1)).toLowerCase();
    logger.warn(`attempt_verification pass 1 failed: ${msg1}`);

    if (!msg1.includes('verification_id') && !msg1.includes('verification id')) {
      throw err1; // Not a missing-ID error — propagate as-is (wrong code, expired, etc.)
    }

    // Pass 2: use the verificationId returned from prepare_verification (ver_xxx)
    if (verificationId && !verificationId.startsWith('eoa_') && !verificationId.startsWith('idn_')) {
      try {
        logger.info(`attempt_verification pass 2 (with verificationId: ${verificationId})`);
        return await clerkAPI('POST', endpoint, { code: String(code), verification_id: String(verificationId) });
      } catch (err2) {
        logger.warn(`attempt_verification pass 2 failed: ${JSON.stringify(err2?.errors?.[0])}`);
      }
    }

    // Pass 3: use the email address ID itself as verification_id
    // (Clerk may treat this as a reference to the active pending verification)
    try {
      logger.info(`attempt_verification pass 3 (verification_id = emailAddressId: ${emailAddressId})`);
      return await clerkAPI('POST', endpoint, { code: String(code), verification_id: String(emailAddressId) });
    } catch (err3) {
      logger.warn(`attempt_verification pass 3 failed: ${JSON.stringify(err3?.errors?.[0])}`);
      throw err3; // All attempts exhausted
    }
  }
};


// ==================== SIGN UP ====================
const signUp = async ({ email, password, username, name }) => {
  try {
    const cleanUsername = (username || email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 15);

    // Create the Clerk user via SDK
    const user = await clerk.users.createUser({
      emailAddress:       [email],
      password,
      username:           cleanUsername,
      firstName:          name ? name.split(' ')[0] : cleanUsername,
      lastName:           name ? name.split(' ').slice(1).join(' ') : '',
      skipPasswordChecks: false,
    });

    logger.info(`Clerk signUp: ${email} | id: ${user.id}`);

    // SDK uses camelCase: user.emailAddresses[0].id
    const emailAddr = user.emailAddresses?.[0];
    let verificationId   = null;
    let emailAddressId   = emailAddr?.id ?? null;

    if (emailAddressId) {
      try {
        // prepare_verification via raw HTTPS (SDK doesn't expose this method)
        const prepared = await clerkAPI(
          'POST',
          `/email_addresses/${emailAddressId}/prepare_verification`,
          { strategy: 'email_code' }
        );

        // Log the FULL response to diagnose verification.id presence
        logger.info(`prepare_verification raw response for ${email}: ${JSON.stringify(prepared)}`);

        // Extract verification ID from every possible location in the response
        verificationId =
          prepared?.verification?.id   // standard field (ver_xxx)
          ?? prepared?.nonce            // fallback: nonce sometimes carries session id
          ?? null;

        logger.info(`Extracted verificationId: ${verificationId} | emailAddressId: ${emailAddressId}`);
      } catch (e) {
        logger.error(`prepare_verification FAILED for ${email}: ${JSON.stringify(e)}`);
      }
    }

    return {
      clerkUserId:      user.id,
      emailVerification: emailAddr?.verification?.status === 'verified',
      emailAddressId,
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
    const msg = err?.errors?.[0]?.longMessage || err?.errors?.[0]?.message || err?.message || 'Signup failed';
    throw new Error(msg);
  }
};


// ==================== CONFIRM SIGN UP (email verification) ====================
const confirmSignUp = async ({ email, code, verificationId, emailAddressId }) => {
  try {
    logger.info(`confirmSignUp: email=${email} verificationId=${verificationId} emailAddressId=${emailAddressId}`);

    // Look up the current Clerk user to get the live email address ID
    const user = await findByEmail(email);
    if (!user) throw new Error('User not found.');

    // SDK uses camelCase: emailAddresses[0].emailAddress
    const emailAddr = user.emailAddresses?.find(a => a.emailAddress === email);
    if (!emailAddr) throw new Error('Email address not found on this account.');

    // Short-circuit if Clerk already considers it verified
    if (emailAddr.verification?.status === 'verified') {
      logger.info(`Email ${email} is already verified — skipping attempt`);
      return { success: true };
    }

    // Use fresh emailAddressId from lookup (more reliable than the one from localStorage)
    const liveEmailAddressId = emailAddr.id;

    const result = await attemptEmailVerification(
      liveEmailAddressId,
      code,
      verificationId     // may be null — attemptEmailVerification handles fallbacks
    );

    if (result?.verification?.status !== 'verified') {
      logger.error(`Unexpected verification status: ${result?.verification?.status} | result: ${JSON.stringify(result)}`);
      const e = new Error('Invalid verification code.');
      e.name = 'CodeMismatchException';
      throw e;
    }

    logger.info(`✅ Email verified for ${email}`);
    return { success: true };
  } catch (err) {
    if (err.name === 'CodeMismatchException' || err.name === 'ExpiredCodeException') throw err;

    logger.error('Clerk confirmSignUp error:', JSON.stringify(err, null, 2));
    const firstError = err?.errors?.[0] || {};
    const errorCode  = firstError.code || '';
    const errorMsg   = firstError.longMessage || firstError.long_message || firstError.message || err.message || '';

    if (errorCode === 'verification_already_verified' || errorCode === 'strategy_for_user_invalid') {
      try {
        const recheck = await findByEmail(email);
        const addr = recheck?.emailAddresses?.find(a => a.emailAddress === email);
        if (addr?.verification?.status === 'verified') {
          logger.info(`Email ${email} already verified — treating as success`);
          return { success: true };
        }
      } catch (_) {}
      const e = new Error('No pending verification. Please request a new code.');
      e.name = 'CodeMismatchException';
      throw e;
    }

    if (errorCode === 'form_code_incorrect' || errorMsg.toLowerCase().includes('incorrect') || errorMsg.toLowerCase().includes('invalid')) {
      const e = new Error('Invalid verification code.');
      e.name = 'CodeMismatchException';
      throw e;
    }
    if (errorCode === 'form_code_expired' || errorMsg.toLowerCase().includes('expired')) {
      const e = new Error('Code expired. Please request a new one.');
      e.name = 'ExpiredCodeException';
      throw e;
    }

    const e = new Error(errorMsg || 'Verification failed. Please try again.');
    e.name = 'VerificationFailedException';
    throw e;
  }
};


// ==================== LOGIN ====================
const login = async ({ email, password }) => {
  try {
    logger.info(`Clerk login attempt for: ${email}`);

    const user = await findByEmail(email);
    if (!user) {
      const e = new Error('Incorrect email or password.');
      e.name  = 'NotAuthorizedException';
      throw e;
    }

    const emailAddr = user.emailAddresses?.find(a => a.emailAddress === email);

    if (emailAddr && emailAddr.verification?.status !== 'verified') {
      const e = new Error('Please verify your email before logging in.');
      e.name  = 'UserNotConfirmedException';
      throw e;
    }

    // SDK verifyPassword throws ClerkAPIError on wrong password
    await clerk.users.verifyPassword({ userId: user.id, password });

    logger.info(`✅ Login successful for: ${email} (clerkId: ${user.id})`);
    return { success: true, clerkUserId: user.id };

  } catch (err) {
    if (err.name === 'NotAuthorizedException' || err.name === 'UserNotConfirmedException') throw err;

    logger.error('Clerk login error:', JSON.stringify(err, null, 2));
    const firstError = err?.errors?.[0] || {};

    if (firstError.code === 'form_password_incorrect' || firstError.code === 'not_found') {
      const e = new Error('Incorrect email or password.');
      e.name  = 'NotAuthorizedException';
      throw e;
    }

    const e = new Error('Login failed. Please try again.');
    e.name  = 'NotAuthorizedException';
    throw e;
  }
};


// ==================== RESEND CONFIRMATION CODE ====================
const resendConfirmationCode = async ({ email }) => {
  try {
    logger.info(`Resending verification code for: ${email}`);

    const user = await findByEmail(email);
    if (!user) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    const emailAddr = user.emailAddresses?.find(a => a.emailAddress === email);
    if (!emailAddr) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    if (emailAddr.verification?.status === 'verified') {
      return { success: true, verificationId: null, emailAddressId: emailAddr.id };
    }

    const prepared = await clerkAPI(
      'POST',
      `/email_addresses/${emailAddr.id}/prepare_verification`,
      { strategy: 'email_code' }
    );
    logger.info(`resend prepare_verification raw response: ${JSON.stringify(prepared)}`);

    const newVerificationId = prepared?.verification?.id ?? null;
    logger.info(`Code resent to ${email} | emailAddrId: ${emailAddr.id} | verificationId: ${newVerificationId}`);

    return { success: true, verificationId: newVerificationId, emailAddressId: emailAddr.id };
  } catch (err) {
    if (err.name === 'UserNotFoundException') throw err;

    logger.error('Resend code error:', JSON.stringify(err));
    const firstError = err?.errors?.[0] || {};

    if (firstError.code?.includes('rate_limit') || firstError.code?.includes('too_many')) {
      const e = new Error('Too many attempts. Please wait before requesting another code.');
      e.name  = 'LimitExceededException';
      throw e;
    }

    throw new Error(firstError.longMessage || firstError.message || 'Failed to resend verification code.');
  }
};


// ==================== FORGOT PASSWORD ====================
const forgotPassword = async ({ email }) => {
  try {
    const user = await findByEmail(email);
    if (!user) {
      logger.info(`Password reset requested for unregistered email: ${email}`);
      return { success: true };
    }

    const emailAddr = user.emailAddresses?.find(a => a.emailAddress === email);
    if (!emailAddr) return { success: true };

    await clerkAPI('POST', `/email_addresses/${emailAddr.id}/prepare_verification`, { strategy: 'email_code' });
    logger.info(`Password reset code sent to ${email} via Clerk`);
    return { success: true };
  } catch (err) {
    logger.error(`forgotPassword error for ${email}: ${JSON.stringify(err)}`);
    return { success: true };
  }
};


// ==================== CONFIRM FORGOT PASSWORD ====================
const confirmForgotPassword = async ({ email, code, newPassword }) => {
  try {
    const user = await findByEmail(email);
    if (!user) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    const emailAddr = user.emailAddresses?.find(a => a.emailAddress === email);
    if (!emailAddr) {
      const e = new Error('No account found with this email.');
      e.name  = 'UserNotFoundException';
      throw e;
    }

    const result = await attemptEmailVerification(emailAddr.id, code, null);

    if (result?.verification?.status !== 'verified') {
      const e = new Error('Invalid verification code.');
      e.name  = 'CodeMismatchException';
      throw e;
    }

    // SDK updateUser to set new password
    await clerk.users.updateUser(user.id, { password: newPassword, skipPasswordChecks: false });

    logger.info(`✅ Password reset successful for ${email}`);
    return { success: true };
  } catch (err) {
    if (['CodeMismatchException', 'ExpiredCodeException', 'UserNotFoundException'].includes(err.name)) throw err;

    logger.error('confirmForgotPassword error:', JSON.stringify(err, null, 2));
    const firstError = err?.errors?.[0] || {};
    const errorMsg   = firstError.longMessage || firstError.long_message || firstError.message || err.message || 'Password reset failed';

    if (firstError.code === 'form_code_incorrect' || errorMsg.toLowerCase().includes('incorrect') || errorMsg.toLowerCase().includes('invalid code')) {
      const e = new Error('Invalid verification code.');
      e.name  = 'CodeMismatchException';
      throw e;
    }
    if (firstError.code === 'form_code_expired' || errorMsg.toLowerCase().includes('expired')) {
      const e = new Error('Code expired. Please request a new one.');
      e.name  = 'ExpiredCodeException';
      throw e;
    }
    if (firstError.code?.includes('password') || errorMsg.toLowerCase().includes('password')) {
      const e = new Error(errorMsg || 'Password does not meet requirements.');
      e.name  = 'InvalidPasswordException';
      throw e;
    }

    throw new Error(errorMsg);
  }
};


// ==================== SIGN OUT ====================
const signOut = async () => {
  logger.info('signOut called — JWT cleared by client');
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
