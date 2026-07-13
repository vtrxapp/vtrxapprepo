// ─────────────────────────────────────────────────────────────────────────────
// config/aws.js — AWS SDK Setup
// ─────────────────────────────────────────────────────────────────────────────
// Auth is handled by Clerk (clerkService.js), not AWS Cognito.
// This file only exports the Secrets Manager client, used to securely fetch
// runtime API keys (OpenAI, Ymove) without hardcoding them.
// ─────────────────────────────────────────────────────────────────────────────

const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');

const region = process.env.AWS_REGION || 'us-east-1';

const secretsClient = new SecretsManagerClient({ region });

module.exports = { secretsClient };
