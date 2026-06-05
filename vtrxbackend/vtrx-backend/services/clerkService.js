// services/clerkService.js — Clerk Authentication using official SDK (improved verification)
const { clerkClient } = require('@clerk/clerk-sdk-node');
const logger = require('../utils/logger');

const clerk = clerkClient;

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
logger.info(`CLERK_SECRET_KEY loaded: ${!!CLERK_SECRET}`);

// ==================== SIGN UP ====================
const signUp = async ({ email, password, username, name }) => {
  try {
    const cleanUsername = (username || email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 15);

    const user = await clerk.users.createUser({
      emailAddress: [email],
      password,
      username: cleanUsername,
      firstName: name ? name.split(' ')[0] : cleanUsername,
      lastName: name ? name.split(' ').slice(1).join(' ') : '',
    });

    logger.info(`Clerk signUp: ${email} | id: ${user.id}`);

    const emailAddr = user.emailAddresses?.[0];
    if (emailAddr && emailAddr.verification?.status !== 'verified') {
      try {
        await clerk.emailAddresses.prepareVerification({
          emailAddressId: emailAddr.id,
          strategy: 'email_code',
        });
        logger.info(`Verification email triggered for ${email}`);
      } catch (e) {
        logger.warn(`Verification email send failed for ${email}: ${JSON.stringify(e)}`);
      }
    }

    return { clerkUserId: user.id, emailVerification: false };
  } catch (err) {
    logger.error('Clerk signUp error:', JSON.stringify(err));
    const code = err?.errors?.[0]?.code || '';
    if (code === 'form_identifier_exists' || code === 'identifier_already_exists') {
      const e = new Error('Account already exists.'); 
      e.name = 'UsernameExistsException'; 
      throw e;
    }
    throw new Error(err?.errors?.[0]?.longMessage || err?.errors?.[0]?.message || 'Signup failed');
  }
};

// ==================== CONFIRM SIGN UP ====================
const confirmSignUp = async ({ email, code }) => {
  try {
    logger.info(`confirmSignUp called with email: ${email} code: ${code}`);

    const { data: users } = await clerk.users.getUserList({ emailAddress: [email] });
    
    if (!users?.length) {
      const e = new Error('User not found.'); 
      e.name = 'UserNotFoundException'; 
      throw e;
    }

    const user = users[0];
    const emailAddr = user.emailAddresses?.find(e => e.emailAddress === email);

    if (!emailAddr) {
      const e = new Error('Email not found.'); 
      e.name = 'UserNotFoundException'; 
      throw e;
    }

    logger.info(`Attempting verification for emailAddr.id: ${emailAddr.id} with code: ${code}`);

    await clerk.emailAddresses.attemptVerification({
      emailAddressId: emailAddr.id,
      code: String(code),
    });

    logger.info(`Clerk confirmSignUp success: ${email}`);
  } catch (err) {
    logger.error('Clerk confirmSignUp error:', JSON.stringify(err));
    const errCode = err?.errors?.[0]?.code || err?.message || '';

    if (errCode.includes('incorrect') || errCode