// ─────────────────────────────────────────────────────────────────────────────
// config/aws.js — AWS SDK Setup
// ─────────────────────────────────────────────────────────────────────────────
// This file creates pre-configured AWS service clients.
// We create them once here and import them wherever needed,
// rather than re-creating them in every file.
// ─────────────────────────────────────────────────────────────────────────────

const { CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
const { SecretsManagerClient }          = require('@aws-sdk/client-secrets-manager');

// AWS region from your .env file
const region = process.env.AWS_REGION || 'us-east-1';

// ── Cognito Client ────────────────────────────────────────────────────────────
// Used for: signup, login, logout, forgot password, token verification
const cognitoClient = new CognitoIdentityProviderClient({
  region,
  // In production on AWS Lambda/EC2, credentials come from the IAM role automatically.
  // For local development, they come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env
});

// ── Secrets Manager Client ────────────────────────────────────────────────────
// Used for: securely fetching API keys (OpenAI, Ymove) at runtime
// This way secrets never live in your code or .env in production
const secretsClient = new SecretsManagerClient({ region });

module.exports = { cognitoClient, secretsClient };
