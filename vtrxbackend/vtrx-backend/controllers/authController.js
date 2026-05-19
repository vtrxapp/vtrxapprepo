// ─────────────────────────────────────────────────────────────────────────────
// controllers/authController.js — Authentication Controller
// ─────────────────────────────────────────────────────────────────────────────
// Controllers handle the business logic for each API endpoint.
// They receive a request, do the work, and send a response.
//
// Auth flow:
// 1. SIGNUP: Create user in Cognito + create user record in our database
// 2. LOGIN:  Authenticate with Cognito → issue our own JWT for the app
// 3. LOGOUT: Invalidate Cognito tokens
// 4. FORGOT PASSWORD: Cognito sends reset email
// ─────────────────────────────────────────────────────────────────────────────

const jwt     = require('jsonwebtoken');
const prisma  = require('../config/database');
const cognito = require('../services/cognitoService');
const logger  = require('../utils/logger');
const { validationResult } = require('express-validator');

// Helper: sign our own JWT (separate from Cognito tokens)
const signToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
const signup = async (req, res) => {
  // Validate request body
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { email, password, username, name, gender, age } = req.body;

  try {
    // Step 1: Create user in AWS Cognito (handles password hashing)
    const { cognitoUserId, emailVerification } = await cognito.signUp({
      email, password, username, name,
    });

    // Step 2: Create user record in our PostgreSQL database
    const user = await prisma.user.create({
      data: {
        cognitoId: cognitoUserId,
        email:     email.toLowerCase(),
        username:  username.toLowerCase(),
        name:      name || username,
        gender,
        age:       age ? parseInt(age) : null,
      },
    });

    // Step 3: Create a free subscription record for this user
    await prisma.subscription.create({
      data: {
        userId: user.id,
        plan:   'free',
        status: 'active',
      },
    });

    logger.info(`New user signed up: ${email}`);

    res.status(201).json({
      success: true,
      message: emailVerification
        ? 'Account created! Please check your email to verify your account.'
        : 'Account created successfully.',
      data: {
        userId:            user.id,
        email:             user.email,
        emailVerification,
      },
    });

  } catch (error) {
    // Handle Cognito-specific errors with friendly messages
    if (error.name === 'UsernameExistsException') {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }
    if (error.name === 'InvalidPasswordException') {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters with uppercase, lowercase and numbers.' });
    }
    logger.error('Signup error:', error);
    res.status(500).json({ success: false, message: 'Signup failed. Please try again.' });
  }
};

// ── POST /api/auth/confirm-email ──────────────────────────────────────────────
const confirmEmail = async (req, res) => {
  const { email, code } = req.body;

  try {
    await cognito.confirmSignUp({ email, code });
    res.json({ success: true, message: 'Email confirmed! You can now log in.' });
  } catch (error) {
    if (error.name === 'CodeMismatchException') {
      return res.status(400).json({ success: false, message: 'Invalid verification code.' });
    }
    if (error.name === 'ExpiredCodeException') {
      return res.status(400).json({ success: false, message: 'Code expired — request a new one.' });
    }
    logger.error('Confirm email error:', error);
    res.status(500).json({ success: false, message: 'Verification failed.' });
  }
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { email, password } = req.body;

  try {
    // Step 1: Authenticate with Cognito
    const cognitoTokens = await cognito.login({ email, password });

    // Step 2: Find the user in our database
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { subscription: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Account not found. Please sign up.',
      });
    }

    // Step 3: Update last active timestamp
    await prisma.user.update({
      where: { id: user.id },
      data:  { lastActiveAt: new Date() },
    });

    // Step 4: Issue our own JWT (short-lived, for API authentication)
    const token = signToken(user.id);

    logger.info(`User logged in: ${email}`);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,                          // Our JWT for API requests
        cognitoTokens,                  // Cognito tokens for AWS services
        user: {
          id:          user.id,
          email:       user.email,
          username:    user.username,
          name:        user.name,
          avatarUrl:   user.avatarUrl,
          goal:        user.goal,
          isPremium:   user.isPremium,
          streakDays:  user.streakDays,
          plan:        user.subscription?.plan || 'free',
        },
      },
    });

  } catch (error) {
    if (error.name === 'NotAuthorizedException') {
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }
    if (error.name === 'UserNotConfirmedException') {
      return res.status(401).json({ success: false, message: 'Please verify your email before logging in.', code: 'EMAIL_NOT_CONFIRMED' });
    }
    if (error.name === 'UserNotFoundException') {
      return res.status(404).json({ success: false, message: 'No account found with this email.' });
    }
    logger.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
};

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
const logout = async (req, res) => {
  const { cognitoAccessToken } = req.body;

  try {
    if (cognitoAccessToken) {
      await cognito.signOut({ accessToken: cognitoAccessToken });
    }
    // Our JWT is stateless — the client just deletes it
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    // Still return success — client should delete their token regardless
    res.json({ success: true, message: 'Logged out' });
  }
};

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  try {
    await cognito.forgotPassword({ email });
    // Always return success even if email doesn't exist (security best practice)
    res.json({
      success: true,
      message: 'If an account exists with this email, you will receive a password reset code.',
    });
  } catch (error) {
    logger.error('Forgot password error:', error);
    res.json({ success: true, message: 'If an account exists with this email, you will receive a password reset code.' });
  }
};

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
const resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;

  try {
    await cognito.confirmForgotPassword({ email, code, newPassword });
    res.json({ success: true, message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    if (error.name === 'CodeMismatchException') {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset code.' });
    }
    logger.error('Reset password error:', error);
    res.status(500).json({ success: false, message: 'Password reset failed.' });
  }
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Returns the currently logged in user's profile
const getMe = async (req, res) => {
  // req.user is set by the protect middleware
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: {
      subscription: true,
      _count: {
        select: {
          workoutLogs:   true,
          savedWorkouts: true,
          savedMeals:    true,
        },
      },
    },
  });

  res.json({ success: true, data: { user } });
};

module.exports = {
  signup,
  confirmEmail,
  login,
  logout,
  forgotPassword,
  resetPassword,
  getMe,
};
