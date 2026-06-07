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
const cognito = require('../services/clerkService');
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
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { email, password, username, name, gender, age } = req.body;

  try {
    // Step 1: Create user in Clerk
    const { 
      clerkUserId, 
      emailVerification,
      verificationId   // ← New
    } = await cognito.signUp({ email, password, username, name });

    // Step 2: Create user in database
    const user = await prisma.user.create({
      data: {
        cognitoId: clerkUserId,
        email: email.toLowerCase(),
        username: username.toLowerCase(),
        name: name || username,
        gender,
        age: age ? parseInt(age) : null,
      },
    });

    // Step 3: Free subscription
    await prisma.subscription.create({
      data: {
        userId: user.id,
        plan: 'free',
        status: 'active',
      },
    });

    logger.info(`New user signed up: ${email}`);

    res.status(201).json({
      success: true,
      message: 'Account created! Please check your email to verify your account.',
      data: {
        userId: user.id,
        email: user.email,
        emailVerification,
        verificationId,        // ← Return this to frontend
      },
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
// ── POST /api/auth/confirm-email ──────────────────────────────────────────────
const confirmEmail = async (req, res) => {
  const { email, code, verificationId } = req.body;

  if (!email || !code || !verificationId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Email, code, and verificationId are required' 
    });
  }

  try {
    logger.info(`confirmEmail called with verificationId: ${verificationId} | code: ${code}`);

    await cognito.confirmSignUp({ email, code, verificationId });

    res.json({
      success: true,
      message: 'Email confirmed successfully. You can now log in.'
    });
  } catch (error) {
    logger.error('=== CONFIRM EMAIL ERROR ===', JSON.stringify(error, null, 2));

    const message = error.message || 'Invalid or expired verification code.';

    res.status(400).json({
      success: false,
      message: message
    });
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
    const cognitoTokens = await cognito.login({ email, password });

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

    await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    const token = signToken(user.id);

    logger.info(`User logged in: ${email}`);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        cognitoTokens,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatarUrl,
          goal: user.goal,
          isPremium: user.isPremium,
          streakDays: user.streakDays,
          plan: user.subscription?.plan || 'free',
        },
      },
    });
  } catch (error) {
    logger.error('Login error:', error);

    if (error.name === 'NotAuthorizedException' || error.message?.toLowerCase().includes('incorrect') || error.message?.toLowerCase().includes('invalid')) {
      return res.status(401).json({ 
        success: false, 
        message: 'Incorrect email or password.' 
      });
    }

    if (error.name === 'UserNotConfirmedException') {
      return res.status(401).json({ 
        success: false, 
        message: 'Please verify your email before logging in.', 
        code: 'EMAIL_NOT_CONFIRMED' 
      });
    }

    res.status(500).json({ 
      success: false, 
      message: 'Login failed. Please try again.' 
    });
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


// ── POST /api/auth/resend-code ────────────────────────────────────────────────
// Resends the email verification code to a user who didn't receive it
const resendVerificationCode = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

  try {
    await cognito.resendConfirmationCode({ email });
    res.json({ success: true, message: 'Verification code resent. Check your inbox.' });
  } catch (error) {
    if (error.name === 'LimitExceededException') {
      return res.status(429).json({ success: false, message: 'Too many attempts. Please wait a few minutes.' });
    }
    if (error.name === 'UserNotFoundException') {
      return res.status(404).json({ success: false, message: 'No account found with this email.' });
    }
    logger.error('Resend code error:', error);
    res.status(500).json({ success: false, message: 'Could not resend code. Please try again.' });
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
  resendVerificationCode,
};
