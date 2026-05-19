// ─────────────────────────────────────────────────────────────────────────────
// services/cognitoService.js — AWS Cognito Authentication
// ─────────────────────────────────────────────────────────────────────────────
// What is Cognito?
// AWS Cognito is Amazon's managed authentication service.
// It handles: user accounts, password hashing, email verification,
// forgot password flows, and token generation.
//
// Why use it instead of rolling our own auth?
// - It's battle-tested and secure out of the box
// - It handles email verification automatically
// - It scales to millions of users without extra work
// - JWT tokens it issues work with other AWS services
// ─────────────────────────────────────────────────────────────────────────────

const {
  SignUpCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  GlobalSignOutCommand,
  GetUserCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const crypto = require('crypto');
const { cognitoClient } = require('../config/aws');
const logger = require('../utils/logger');

const USER_POOL_ID  = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID     = process.env.COGNITO_CLIENT_ID;
const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET;

// ── Secret Hash ───────────────────────────────────────────────────────────────
// Some Cognito app clients require a secret hash for each request.
// This computes it. If your app client has no secret, this returns undefined.
const getSecretHash = (username) => {
  if (!CLIENT_SECRET) return undefined;
  return crypto
    .createHmac('SHA256', CLIENT_SECRET)
    .update(username + CLIENT_ID)
    .digest('base64');
};

// ── Sign Up ───────────────────────────────────────────────────────────────────
// Creates a new Cognito user. They get a verification email automatically.
const signUp = async ({ email, password, username, name }) => {
  const command = new SignUpCommand({
    ClientId:     CLIENT_ID,
    Username:     email,      // Cognito uses email as username
    Password:     password,
    SecretHash:   getSecretHash(email),
    UserAttributes: [
      { Name: 'email',       Value: email },
      { Name: 'name',        Value: name || username },
      { Name: 'nickname',    Value: username },
    ],
  });

  const result = await cognitoClient.send(command);
  logger.info(`Cognito signUp: ${email}`);

  return {
    cognitoUserId:     result.UserSub,        // The unique Cognito user ID
    emailVerification: !result.UserConfirmed, // true = email needs confirming
  };
};

// ── Confirm Sign Up (email verification) ─────────────────────────────────────
// User enters the 6-digit code from their verification email
const confirmSignUp = async ({ email, code }) => {
  const command = new ConfirmSignUpCommand({
    ClientId:         CLIENT_ID,
    Username:         email,
    ConfirmationCode: code,
    SecretHash:       getSecretHash(email),
  });

  await cognitoClient.send(command);
  logger.info(`Cognito email confirmed: ${email}`);
  return true;
};

// ── Login ─────────────────────────────────────────────────────────────────────
// Authenticates user and returns tokens (idToken, accessToken, refreshToken)
const login = async ({ email, password }) => {
  const command = new InitiateAuthCommand({
    AuthFlow:       'USER_PASSWORD_AUTH',
    ClientId:       CLIENT_ID,
    AuthParameters: {
      USERNAME:    email,
      PASSWORD:    password,
      SECRET_HASH: getSecretHash(email),
    },
  });

  const result = await cognitoClient.send(command);
  const tokens = result.AuthenticationResult;

  if (!tokens) {
    throw new Error('Authentication failed — no tokens returned');
  }

  logger.info(`Cognito login: ${email}`);

  return {
    idToken:      tokens.IdToken,      // Contains user info (email, name etc)
    accessToken:  tokens.AccessToken,  // Used to call Cognito APIs
    refreshToken: tokens.RefreshToken, // Used to get new tokens when expired
    expiresIn:    tokens.ExpiresIn,    // Seconds until idToken expires (3600)
  };
};

// ── Forgot Password ───────────────────────────────────────────────────────────
// Sends a password reset code to the user's email
const forgotPassword = async ({ email }) => {
  const command = new ForgotPasswordCommand({
    ClientId:   CLIENT_ID,
    Username:   email,
    SecretHash: getSecretHash(email),
  });

  await cognitoClient.send(command);
  logger.info(`Cognito forgot password: ${email}`);
  return true;
};

// ── Confirm Forgot Password ───────────────────────────────────────────────────
// User enters reset code + new password
const confirmForgotPassword = async ({ email, code, newPassword }) => {
  const command = new ConfirmForgotPasswordCommand({
    ClientId:         CLIENT_ID,
    Username:         email,
    ConfirmationCode: code,
    Password:         newPassword,
    SecretHash:       getSecretHash(email),
  });

  await cognitoClient.send(command);
  logger.info(`Cognito password reset: ${email}`);
  return true;
};

// ── Sign Out ──────────────────────────────────────────────────────────────────
// Invalidates all tokens for this user across all devices
const signOut = async ({ accessToken }) => {
  const command = new GlobalSignOutCommand({ AccessToken: accessToken });
  await cognitoClient.send(command);
  logger.info('Cognito global sign out');
  return true;
};

// ── Get Cognito User ──────────────────────────────────────────────────────────
// Fetches user details from Cognito using their access token
const getCognitoUser = async ({ accessToken }) => {
  const command = new GetUserCommand({ AccessToken: accessToken });
  const result  = await cognitoClient.send(command);

  // Convert the attributes array to a plain object
  const attrs = {};
  result.UserAttributes.forEach(a => {
    attrs[a.Name] = a.Value;
  });

  return {
    cognitoId: attrs['sub'],
    email:     attrs['email'],
    name:      attrs['name'],
    username:  attrs['nickname'],
  };
};

module.exports = {
  signUp,
  confirmSignUp,
  login,
  forgotPassword,
  confirmForgotPassword,
  signOut,
  getCognitoUser,
};
