// ─────────────────────────────────────────────────────────────────────────────
// controllers/authController.js — Authentication Controller
// ─────────────────────────────────────────────────────────────────────────────
// Auth flow (powered by Clerk BAPI):
// 1. SIGNUP: Create user in Clerk + create user record in our database
// 2. LOGIN:  Verify credentials with Clerk → issue our own JWT for the app
// 3. LOGOUT: Stateless JWT — client deletes token from localStorage
// 4. FORGOT PASSWORD: Clerk sends reset email via email_code verification
// ─────────────────────────────────────────────────────────────────────────────

const jwt    = require('jsonwebtoken');
const prisma = require('../config/database');
const clerk  = require('../services/clerkService');
const logger = require('../utils/logger');
const { validationResult } = require('express-validator');
const notif  = require('../services/notificationService');
const { sendWelcomeEmail } = require('../services/emailService');
const make   = require('../services/makeService');

const signToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
const signup = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { email, password, username, name, gender, age } = req.body;

  try {
    const { clerkUserId, emailVerification, verificationId, emailAddressId } =
      await clerk.signUp({ email, password, username, name });

    const user = await prisma.user.create({
      data: {
        cognitoId: clerkUserId,   // column keeps its name; value is the Clerk user ID
        email: email.toLowerCase(),
        username: username.toLowerCase(),
        name: name || username,
        gender,
        age: age ? parseInt(age) : null,
      },
    });

    await prisma.subscription.create({
      data: { userId: user.id, plan: 'free', status: 'active' },
    });

    logger.info(`New user signed up: ${email}`);

    // Fire-and-forget — don't await so it never delays the signup response
    sendWelcomeEmail({ email: user.email, name: user.name }).catch(() => {});
    make.send('USER_SIGNUP', { email: user.email, name: user.name, userId: user.id });

    res.status(201).json({
      success: true,
      message: 'Account created! Please check your email to verify your account.',
      data: { userId: user.id, email: user.email, emailVerification, verificationId, emailAddressId },
    });
  } catch (error) {
    if (error.name === 'UsernameExistsException') {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }
    logger.error('Signup error:', error);
    res.status(500).json({ success: false, message: 'Signup failed. Please try again.' });
  }
};

// ── POST /api/auth/confirm-email ──────────────────────────────────────────────
const confirmEmail = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { email, code, verificationId, emailAddressId } = req.body;

  if (!email || !code) {
    return res.status(400).json({ success: false, message: 'Email and code are required' });
  }

  try {
    logger.info(`confirmEmail called with verificationId: ${verificationId} | emailAddressId: ${emailAddressId}`);

    await clerk.confirmSignUp({ email, code, verificationId, emailAddressId });

    res.json({ success: true, message: 'Email confirmed successfully. You can now log in.' });
  } catch (error) {
    logger.error('=== CONFIRM EMAIL ERROR ===', JSON.stringify(error, null, 2));
    res.status(400).json({ success: false, message: error.message || 'Invalid or expired verification code.' });
  }
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { email, password, clientHour } = req.body;

  try {
    await clerk.login({ email, password });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { subscription: true },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found. Please sign up.' });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });

    const token = signToken(user.id);

    logger.info(`User logged in: ${email}`);

    // Fire-and-forget welcome notification
    const hour = (clientHour !== undefined && Number.isInteger(+clientHour) && +clientHour >= 0 && +clientHour <= 23)
      ? +clientHour
      : new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const rawName   = (user.name || user.username || '').split(' ')[0];
    const firstName = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : '';
    notif.sendToUser({
      userId: user.id,
      title:  `${greeting}${firstName ? ', ' + firstName : ''} 👋`,
      body:   'Welcome back to VTRX. Ready to crush today?',
      data:   { type: 'welcome' },
    }).catch(() => {});

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          id:           user.id,
          email:        user.email,
          username:     user.username,
          name:         user.name,
          avatarUrl:    user.avatarUrl,
          age:          user.age,
          goal:         user.goal,
          fitnessLevel: user.fitnessLevel,
          daysPerWeek:  user.daysPerWeek,
          weight:       user.weight,
          height:       user.height,
          gender:       user.gender,
          equipment:    user.equipment,
          location:     user.location,
          isPremium:    user.isPremium,
          streakDays:   user.streakDays,
          plan:         user.subscription?.plan || 'free',
        },
      },
    });
  } catch (error) {
    logger.error('Login error:', error);

    if (error.name === 'NotAuthorizedException' || error.message?.toLowerCase().includes('incorrect') || error.message?.toLowerCase().includes('invalid')) {
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }

    if (error.name === 'UserNotConfirmedException') {
      return res.status(401).json({ success: false, message: 'Please verify your email before logging in.', code: 'EMAIL_NOT_CONFIRMED' });
    }

    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
};

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
// JWT is stateless — the client just deletes it. No server-side revocation needed.
const logout = async (req, res) => {
  try {
    await clerk.signOut();
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.json({ success: true, message: 'Logged out' });
  }
};

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  try {
    const result = await clerk.forgotPassword({ email });
    res.json({
      success: true,
      message: 'If an account exists with this email, you will receive a password reset code.',
      data: { verificationId: result.verificationId || null, emailAddressId: result.emailAddressId || null },
    });
  } catch (error) {
    logger.error('Forgot password error:', error);
    res.json({ success: true, message: 'If an account exists with this email, you will receive a password reset code.', data: {} });
  }
};

// ── POST /api/auth/resend-code ────────────────────────────────────────────────
const resendVerificationCode = async (req, res) => {
  const { email, emailAddressId } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

  try {
    const result = await clerk.resendConfirmationCode({ email, emailAddressId });
    res.json({ success: true, message: 'If this email is registered and unverified, a new code has been sent.', data: { verificationId: result.verificationId || null, emailAddressId: result.emailAddressId || null } });
  } catch (error) {
    if (error.name === 'LimitExceededException') {
      return res.status(429).json({ success: false, message: 'Too many attempts. Please wait a few minutes.' });
    }
    if (error.name === 'UserNotFoundException') {
      // Never reveal whether an email exists — always return 200 with a generic message
      return res.status(200).json({ success: true, message: 'If this email is registered and unverified, a new code has been sent.' });
    }
    logger.error('Resend code error:', error);
    res.status(500).json({ success: false, message: 'Could not resend code. Please try again.' });
  }
};

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
const resetPassword = async (req, res) => {
  const { email, code, newPassword, verificationId, emailAddressId } = req.body;

  if (!email || !code || !newPassword) {
    return res.status(400).json({ success: false, message: 'Email, code, and new password are required.' });
  }

  try {
    await clerk.confirmForgotPassword({ email, code, newPassword, verificationId: verificationId || null, emailAddressId: emailAddressId || null });
    res.json({ success: true, message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    if (error.name === 'CodeMismatchException')    return res.status(400).json({ success: false, message: 'Invalid verification code.' });
    if (error.name === 'ExpiredCodeException')     return res.status(400).json({ success: false, message: 'Code expired. Please request a new one.' });
    if (error.name === 'InvalidPasswordException') return res.status(400).json({ success: false, message: error.message || 'Password does not meet requirements.' });
    if (error.name === 'UserNotFoundException')    return res.status(404).json({ success: false, message: 'No account found with this email.' });
    logger.error('Reset password error:', error);
    res.status(500).json({ success: false, message: 'Password reset failed. Please try again.' });
  }
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        subscription: true,
        _count: { select: { workoutLogs: true, savedWorkouts: true, savedMeals: true } },
      },
    });
    res.json({ success: true, data: { user } });
  } catch (error) {
    logger.error('getMe error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
};

// ── POST /api/auth/change-password (protected) ────────────────────────────────
const changePassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Current and new password are required.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    await clerk.changePassword({ userId: user.cognitoId, currentPassword, newPassword });
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    if (error.name === 'NotAuthorizedException') {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }
    if (error.name === 'InvalidPasswordException') {
      return res.status(400).json({ success: false, message: error.message || 'Password does not meet requirements.' });
    }
    logger.error('changePassword error:', error);
    res.status(500).json({ success: false, message: 'Failed to update password.' });
  }
};

module.exports = { signup, confirmEmail, login, logout, forgotPassword, resetPassword, getMe, resendVerificationCode, changePassword };
