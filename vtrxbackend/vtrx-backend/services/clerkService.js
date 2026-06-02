// services/clerkService.js — Clerk Authentication (replaces Cognito)
const { createClerkClient } = require('@clerk/backend');
const logger = require('../utils/logger');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const signUp = async ({ email, password, username, name }) => {
  try {
    const cleanUsername = (username || email.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 15);

    const user = await clerk.users.createUser({
      emailAddress: [email],
      password,
      username: cleanUsername,
      firstName: name ? name.split(' ')[0] : cleanUsername,
      lastName:  name ? name.split(' ').slice(1).join(' ') : '',
      skipPasswordChecks: false,
    });

    logger.info(`Clerk signUp: ${email}`);
    return { clerkUserId: user.id, emailVerification: true };
  } catch (err) {
    logger.error('Clerk signUp error:', err?.errors || err?.message || err);
    if (err?.errors?.[0]?.code === 'form_identifier_exists') {
      const e = new Error('Account already exists.'); e.name = 'UsernameExistsException'; throw e;
    }
    if (err?.errors?.[0]?.code === 'form_password_pwned' || err?.errors?.[0]?.code === 'form_password_length_too_short') {
      const e = new Error('Password must be at least 8 characters with uppercase, lowercase and numbers.'); e.name = 'InvalidPasswordException'; throw e;
    }
    throw err;
  }
};

const confirmSignUp = async ({ email, code }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data || users.data.length === 0) throw new Error('UserNotFoundException');
    const user = users.data[0];
    const emailAddr = user.emailAddresses.find(e => e.emailAddress === email);
    if (!emailAddr) throw new Error('UserNotFoundException');
    await clerk.emailAddresses.verifyEmailAddress(user.id, emailAddr.id, { code });
    logger.info(`Clerk confirmSignUp: ${email}`);
  } catch (err) {
    logger.error('Clerk confirmSignUp error:', err?.errors || err?.message || err);
    if (err?.errors?.[0]?.code?.includes('incorrect') || err?.message?.includes('incorrect_code')) {
      const e = new Error('Invalid code.'); e.name = 'CodeMismatchException'; throw e;
    }
    if (err?.errors?.[0]?.code?.includes('expired') || err?.message?.includes('expired')) {
      const e = new Error('Code expired.'); e.name = 'ExpiredCodeException'; throw e;
    }
    throw err;
  }
};

const login = async ({ email, password }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data || users.data.length === 0) {
      const e = new Error('Not found.'); e.name = 'UserNotFoundException'; throw e;
    }
    const user = users.data[0];
    const verified = await clerk.users.verifyPassword({ userId: user.id, password });
    if (!verified) {
      const e = new Error('Wrong password.'); e.name = 'NotAuthorizedException'; throw e;
    }
    const emailAddr = user.emailAddresses.find(e => e.emailAddress === email);
    if (emailAddr && emailAddr.verification?.status !== 'verified') {
      const e = new Error('Please verify your email.'); e.name = 'UserNotConfirmedException'; throw e;
    }
    return { accessToken: user.id };
  } catch (err) {
    logger.error('Clerk login error:', err?.errors || err?.message || err);
    throw err;
  }
};

const resendConfirmationCode = async ({ email }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data || users.data.length === 0) {
      const e = new Error('Not found.'); e.name = 'UserNotFoundException'; throw e;
    }
    const user = users.data[0];
    const emailAddr = user.emailAddresses.find(e => e.emailAddress === email);
    if (emailAddr) {
      await clerk.emailAddresses.createEmailAddressVerification(user.id, emailAddr.id, { strategy: 'email_code' });
    }
    logger.info(`Clerk resendCode: ${email}`);
  } catch (err) {
    logger.error('Clerk resendCode error:', err?.errors || err?.message || err);
    throw err;
  }
};

const forgotPassword = async ({ email }) => {
  logger.info(`Clerk forgotPassword: ${email}`);
};

const confirmForgotPassword = async ({ email, code, newPassword }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data || users.data.length === 0) throw new Error('UserNotFoundException');
    await clerk.users.updateUser(users.data[0].id, { password: newPassword });
    logger.info(`Clerk resetPassword: ${email}`);
  } catch (err) {
    logger.error('Clerk resetPassword error:', err?.errors || err?.message || err);
    throw err;
  }
};

const signOut = async ({ accessToken }) => {
  try {
    if (accessToken) await clerk.sessions.revokeSession(accessToken);
  } catch(_e) {}
};

module.exports = { signUp, confirmSignUp, login, resendConfirmationCode, forgotPassword, confirmForgotPassword, signOut };