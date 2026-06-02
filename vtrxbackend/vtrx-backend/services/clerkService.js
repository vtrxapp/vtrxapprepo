// services/clerkService.js — Clerk Authentication (replaces Cognito)
const { createClerkClient } = require('@clerk/backend');
const logger = require('../utils/logger');

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const signUp = async ({ email, password, username, name }) => {
  try {
    const user = await clerk.users.createUser({
      emailAddress: [email],
      password,
      username,
      firstName: name ? name.split(' ')[0] : username,
      lastName:  name ? name.split(' ').slice(1).join(' ') : '',
    });
    const emailId = user.emailAddresses[0]?.id;
    if (emailId) {
      await clerk.emailAddresses.createEmailAddressVerification(user.id, emailId, { strategy: 'email_code' });
    }
    logger.info(`Clerk signUp: ${email}`);
    return { clerkUserId: user.id, emailVerification: true };
  } catch (err) {
    logger.error('Clerk signUp error:', err);
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
    logger.error('Clerk confirmSignUp error:', err);
    if (err.message?.includes('incorrect_code')) { const e = new Error('Invalid code.'); e.name = 'CodeMismatchException'; throw e; }
    if (err.message?.includes('expired')) { const e = new Error('Code expired.'); e.name = 'ExpiredCodeException'; throw e; }
    throw err;
  }
};

const login = async ({ email, password }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data || users.data.length === 0) { const e = new Error('Not found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users.data[0];
    const verified = await clerk.users.verifyPassword({ userId: user.id, password });
    if (!verified) { const e = new Error('Wrong password.'); e.name = 'NotAuthorizedException'; throw e; }
    if (!user.emailAddresses[0]?.verification?.status === 'verified') { const e = new Error('Not confirmed.'); e.name = 'UserNotConfirmedException'; throw e; }
    return { accessToken: user.id };
  } catch (err) {
    logger.error('Clerk login error:', err);
    throw err;
  }
};

const resendConfirmationCode = async ({ email }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data || users.data.length === 0) { const e = new Error('Not found.'); e.name = 'UserNotFoundException'; throw e; }
    const user = users.data[0];
    const emailAddr = user.emailAddresses.find(e => e.emailAddress === email);
    if (emailAddr) await clerk.emailAddresses.createEmailAddressVerification(user.id, emailAddr.id, { strategy: 'email_code' });
    logger.info(`Clerk resendCode: ${email}`);
  } catch (err) { logger.error('Clerk resendCode error:', err); throw err; }
};

const forgotPassword = async ({ email }) => { logger.info(`Clerk forgotPassword: ${email}`); };

const confirmForgotPassword = async ({ email, code, newPassword }) => {
  try {
    const users = await clerk.users.getUserList({ emailAddress: [email] });
    if (!users.data || users.data.length === 0) throw new Error('UserNotFoundException');
    await clerk.users.updateUser(users.data[0].id, { password: newPassword });
  } catch (err) { logger.error('Clerk resetPassword error:', err); throw err; }
};

const signOut = async ({ accessToken }) => {
  try { if (accessToken) await clerk.sessions.revokeSession(accessToken); } catch (err) {}
};

module.exports = { signUp, confirmSignUp, login, resendConfirmationCode, forgotPassword, confirmForgotPassword, signOut };