# VTRX App — QA & Testing Phases

> Track each item: ✅ Pass | ❌ Fail | ⏳ In Progress | 🔲 Not Yet Tested

---

## Phase 1 — Authentication

### 1.1 Sign Up
- 🔲 Valid details → account created, verification email arrives
- 🔲 Wrong verification code → rejected, error shown, does NOT proceed
- 🔲 Correct verification code → proceeds to preferences onboarding
- 🔲 "Log In" link on sign-up screen → goes to login screen (not onboarding)
- 🔲 Duplicate email → shows "account already exists" error
- 🔲 Weak password (< 8 chars, no uppercase/number) → blocked with message
- 🔲 Invalid email format → blocked with message
- 🔲 Expired verification code → shows "code expired" error, prompts resend
- 🔲 "Resend code" button → new code arrives, old code no longer works

### 1.2 Login
- 🔲 Valid credentials → lands on dashboard
- 🔲 Wrong password → shows "incorrect email or password" (not a 500)
- 🔲 Non-existent email → shows "incorrect email or password" (no account enumeration)
- 🔲 Unverified email → shows "please verify your email" with resend option
- 🔲 Empty fields → blocked with validation message
- 🔲 SQL/script injection in email field → safely handled

### 1.3 Logout
- 🔲 Profile → Account → LOG OUT → confirmation dialog appears
- 🔲 Confirm logout → redirects to onboarding screen
- 🔲 After logout, navigating back does not show dashboard (token cleared)
- 🔲 Logout from Workouts tab (WeightsHub → Profile → Account → Logout)
- 🔲 Logout from Nutrition tab (NutritionHub → Profile → Account → Logout)

### 1.4 Password Reset
- 🔲 Forgot password → submit any email → always shows success message
- 🔲 Valid reset code + new password → can log in with new password
- 🔲 Invalid/expired reset code → shows clear error
- 🔲 New password fails complexity rules → blocked with message
- ⚠️  NOTE: Reset email flow is a stub — needs email service (SendGrid/Resend/SES) wired up before this phase can be fully tested

### 1.5 Session & Token
- 🔲 Refresh page while logged in → stays logged in (token persists in localStorage)
- 🔲 JWT_EXPIRES_IN (7 days) → after expiry, protected routes redirect to login
- 🔲 Tampered JWT → rejected with 401
- 🔲 Missing Authorization header → protected routes return 401
- 🔲 Multi-device login → both sessions work independently
- 🔲 `GET /api/auth/me` with valid token → returns correct user profile

### 1.6 Onboarding Flow
- 🔲 Completing sign-up → preferences screens appear in correct order
- 🔲 Body screen weight field shows "160" placeholder (not pre-filled)
- 🔲 Height field shows placeholder in faint style
- 🔲 Completing all preferences → reaches dashboard

---

## Phase 2 — Stripe & Payments

### 2.1 Subscription Purchase
- 🔲 "Upgrade" button → redirects to Stripe Checkout
- 🔲 Successful payment → user `isPremium` flips to true
- 🔲 Dashboard reflects premium status after payment
- 🔲 Stripe Checkout cancel → returns to app without changing status

### 2.2 Payment Handling
- 🔲 Failed payment (test card `4000 0000 0000 0002`) → shows failure, no access granted
- 🔲 Webhook `checkout.session.completed` → subscription record created in DB
- 🔲 Webhook signature validation → invalid signature rejected with 400
- 🔲 Duplicate webhook event → idempotently handled (not double-processed)

### 2.3 Subscription Lifecycle
- 🔲 `customer.subscription.deleted` webhook → `isPremium` set to false
- 🔲 Subscription renewal → access continues uninterrupted
- 🔲 Cancelled subscription → premium features locked after period ends
- 🔲 `Cancel Subscription` button in profile → cancels in Stripe, DB updated

### 2.4 Access Control
- 🔲 Free user → premium-only features show upgrade prompt
- 🔲 Premium user → premium features accessible
- 🔲 `requirePremium` middleware on premium API routes → free users get 403
- 🔲 Downgraded user → premium features locked on next request

---

## Phase 3 — Workout Features

### 3.1 Workout Logging
- 🔲 Log a workout → appears in workout history
- 🔲 History persists after page refresh
- 🔲 Workout stats (calories, duration) saved correctly
- 🔲 Streak counter increments after logging a workout

### 3.2 Progress Tracking
- 🔲 Weekly workout days counter reflects actual logged workouts
- 🔲 Calorie/minute averages calculate correctly
- 🔲 Personal records (PRs) update when a new max is set
- 🔲 Fitness stats page shows correct totals

### 3.3 Data Isolation
- 🔲 User A cannot see User B's workout logs
- 🔲 All workout API routes require valid JWT
- 🔲 `GET /api/workouts/history` without token → 401
- 🔲 `POST /api/workouts/log` with another user's token → data saved to correct user

---

## Phase 4 — Video Features

### 4.1 Upload & Streaming
- 🔲 Video upload completes without error
- 🔲 Uploaded video streams correctly in-app
- 🔲 Video thumbnail/preview loads

### 4.2 Permissions & Premium Content
- 🔲 Free user → premium videos show lock/upgrade prompt
- 🔲 Premium user → premium videos play
- 🔲 Signed/expiring URLs prevent direct hotlinking
- 🔲 Video API routes require valid JWT

### 4.3 Error Handling
- 🔲 Upload fails gracefully (network error, size limit) → clear error shown
- 🔲 Streaming error → fallback UI shown, not a blank crash

---

## Phase 5 — Security

### 5.1 API Route Protection
- 🔲 All `/api/users/*` routes require JWT
- 🔲 All `/api/workouts/*` routes require JWT
- 🔲 All `/api/nutrition/*` routes require JWT
- 🔲 Premium routes return 403 (not 401) for authenticated free users
- 🔲 `/api/auth/signup`, `/api/auth/login` are publicly accessible

### 5.2 Input Validation
- 🔲 XSS payload in name/username field → sanitized, not stored/reflected raw
- 🔲 Oversized input (10,000 char username) → rejected
- 🔲 Numeric fields (age, weight) → reject non-numeric input

### 5.3 Rate Limiting
- 🔲 Rapid repeated login attempts → rate limiter triggers (429)
- 🔲 Rapid signup attempts from same IP → throttled

### 5.4 CORS
- 🔲 Request from unknown origin → rejected
- 🔲 Request from Vercel frontend origin → accepted
- 🔲 Tighten wildcard `*.vercel.app` to exact production URL before go-live

### 5.5 Secrets & Config
- 🔲 No secrets in committed files (`.env.production` only has `VITE_*` keys)
- 🔲 `CLERK_SECRET_KEY` set only in Railway env vars (rotated, not in git)
- 🔲 `JWT_SECRET` is strong and set in Railway env vars
- 🔲 `STRIPE_WEBHOOK_SECRET` set in Railway env vars

---

## Pending Before Production

| Item | Status |
|---|---|
| Wire password reset to email service (SendGrid/Resend/SES) | 🔲 |
| Tighten CORS from `*.vercel.app` to exact domain | 🔲 |
| Move JWT from localStorage to httpOnly cookie | 🔲 Optional |
| Add server-side token revocation / blocklist for logout | 🔲 Optional |
| Set up error monitoring (Sentry or similar) | 🔲 |
| Set up uptime monitoring for Railway backend | 🔲 |
