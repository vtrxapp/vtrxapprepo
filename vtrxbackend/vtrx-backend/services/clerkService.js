// services/clerkService.js — Clerk Authentication
const { createClerkClient } = require('@clerk/backend');
const logger = require('../utils/logger');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const signUp = async ({ email, password, username, name }) => {
  try {
    const cleanUsername = (username || email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 15);

    const user = await clerk.users.createUser({
      emailAddress: [email],
      password,
      username: cleanUsername,
      firstName: name ? name.split(' ')[0] : cleanUsername,
      lastName:  name ? name.split(' ').slice(1).join(' ') : '',
    });

    logger.info(`Clerk signUp: ${email} | id: ${user.id}`);
    logger.info(`Email status: ${JSON.stringify(user.emailAddresses[0]?.verification)}`);
    return { clerkUserId: user.id, emailVerification: true };
  } catch (err) {
    logger.error('Clerk signUp error:', JSON.stringify(err?.errors || err?.message));
    if (err?.errors?.[0]?.code === 'form_identifier_exists') {
      const e = new Error('Account already exists.'); e.name = 'UsernameExistsException'; throw e;
    }
    throw err;
  }
};

const confirmSignUp = async ({ email, code }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data?.length) { const e = new Error('User not found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users.data[0];
    const emailAddr = user.emailAddresses.find(e => e.emailAddress === email);
    if (!emailAddr) { const e = new Error('Email not found.'); e.name = 'UserNotFoundException'; throw e; }

    logger.info(`Verifying email ${email} addr id: ${emailAddr.id} with code`);

    // Use Clerk REST API directly
    const result = await clerk.emailAddresses.attemptEmailAddressVerification(emailAddr.id, { code });
    logger.info(`Clerk confirmSignUp success: ${email} | result: ${JSON.stringify(result?.verification)}`);
  } catch (err) {
    logger.error('Clerk confirmSignUp error:', JSON.stringify(err?.errors || err?.message));
    const errCode = err?.errors?.[0]?.code || err?.message || '';
    if (errCode.includes('incorrect') || errCode.includes('invalid')) {
      const e = new Error('Invalid verification code.'); e.name = 'CodeMismatchException'; throw e;
    }
    if (errCode.includes('expired')) {
      const e = new Error('Code expired.'); e.name = 'ExpiredCodeException'; throw e;
    }
    throw err;
  }
};

const login = async ({ email, password }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data?.length) { const e = new Error('No account found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users.data[0];

    const emailAddr = user.emailAddresses.find(e => e.emailAddress === email);
    if (emailAddr && emailAddr.verification?.status !== 'verified') {
      const e = new Error('Please verify your email before logging in. Check your inbox.');
      e.name = 'UserNotConfirmedException'; throw e;
    }

    const verified = await clerk.users.verifyPassword({ userId: user.id, password });
    if (!verified) { const e = new Error('Incorrect email or password.'); e.name = 'NotAuthorizedException'; throw e; }

    return { accessToken: user.id };
  } catch (err) {
    logger.error('Clerk login error:', JSON.stringify(err?.errors || err?.message));
    throw err;
  }
};

const resendConfirmationCode = async ({ email }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data?.length) { const e = new Error('User not found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users.data[0];
    const emailAddr = user.emailAddresses.find(e => e.emailAddress === email);
    if (emailAddr) {
      await clerk.emailAddresses.prepareEmailAddressVerification(emailAddr.id, { strategy: 'email_code' });
      logger.info(`Clerk resendCode success: ${email}`);
    }
  } catch (err) {
    logger.error('Clerk resendCode error:', JSON.stringify(err?.errors || err?.message));
    throw err;
  }
};

const forgotPassword = async ({ email }) => { logger.info(`Clerk forgotPassword: ${email}`); };
const confirmForgotPassword = async ({ email, code, newPassword }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data?.length) throw new Error('UserNotFoundException');
    await clerk.users.updateUser(users.data[0].id, { password: newPassword });
  } catch (err) { logger.error('Clerk resetPassword error:', err?.message); throw err; }
};
const signOut = async ({ accessToken }) => {
  try { if (accessToken) await clerk.sessions.revokeSession(accessToken); } catch(_e) {}
};

module.exports = { signUp, confirmSignUp, login, resendConfirmationCode, forgotPassword, confirmForgotPassword, signOut };