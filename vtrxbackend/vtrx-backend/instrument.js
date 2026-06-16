const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "development",
  tracesSampleRate: 0.2, // 20% of requests captured for performance monitoring
  integrations: [
    Sentry.expressIntegration(),
    Sentry.prismaIntegration(),
  ],
});
