# VTRX Backend — Complete Setup Guide
## From Zero to Running API (Beginner-Friendly)

---

## What you now have

```
vtrx-backend/
├── server.js                    ← Entry point — start here
├── package.json                 ← Dependencies list
├── .env.example                 ← Copy this to .env and fill in values
├── .gitignore                   ← Keeps secrets out of git
│
├── config/
│   └── database.js              ← Prisma database client
│
├── prisma/
│   └── schema.prisma            ← Your entire database structure
│
├── middleware/
│   ├── auth.js                  ← Clerk session token verification
│   └── errorHandler.js          ← Catches all errors cleanly
│
├── services/
│   ├── clerkService.js          ← Clerk auth (password change, etc.)
│   ├── stripeService.js         ← Billing/subscriptions
│   ├── supabaseStorageService.js← Progress photo/avatar uploads
│   ├── ymoveService.js          ← Workout/exercise content integration
│   ├── aiService.js / aiPlanGenerator.js / anthropicClient.js
│   │                            ← AI plan generation & coaching summaries (Anthropic)
│   ├── embeddingService.js      ← OpenAI embeddings for Pinecone recommendation
│   │                              search — the one place OpenAI is still used
│   ├── notificationService.js / notificationScheduler.js
│   │                            ← Push notifications (Firebase) + the cron
│   │                              jobs that trigger them (in-process, needs
│   │                              a persistent server — see note below)
│   └── ...                      ← nutritionPlanService, embeddingService,
│                                   pineconeService, emailService, makeService
│
├── controllers/                 ← One per resource (auth, users, workouts,
│                                   nutrition, payments, notifications, ai,
│                                   upload, n8n, linear)
│
├── routes/                      ← /api/<resource>/* endpoint definitions
│
└── utils/
    └── logger.js                ← Structured logging
```

**Auth is Clerk, not AWS Cognito.** Signup/login/password-reset all happen
client-side via Clerk's hosted UI — this backend only verifies the session
token Clerk issues (`middleware/auth.js`) and exposes `/api/auth/me` +
`/api/auth/change-password`.

**This is a long-running process, not serverless.** `notificationScheduler.js`
runs an in-process `node-cron` schedule, and a few one-time sync jobs run at
boot (`server.js`'s `app.listen` callback). It needs a host that keeps the
Node process alive continuously (Railway, Render, Fly.io, a VPS) — it will
not work as-is on a serverless platform (Vercel functions, AWS Lambda)
without rearchitecting those jobs as externally-triggered endpoints.

---

## STEP 1 — Install Node.js (if you haven't)

Go to https://nodejs.org and download the LTS version.
Check it worked:
```bash
node --version   # Should show v18 or higher
npm --version    # Should show v9 or higher
```

---

## STEP 2 — Install dependencies

Open your terminal, navigate to the vtrx-backend folder, then run:
```bash
npm install
```
This downloads all the packages listed in package.json, and (via
`postinstall`) generates the Prisma client and pushes the schema to your
database. **This means `DATABASE_URL` and `DIRECT_URL` must already be set
before you run this** — do Step 3 and Step 4 first, then come back and run
`npm install`. It creates a `node_modules` folder (never commit this to git).

⚠️ `postinstall` runs `prisma db push --accept-data-loss`, which can drop or
rewrite columns/tables to match `schema.prisma` without prompting. Double
check `DATABASE_URL`/`DIRECT_URL` point at the database you actually mean to
touch — not a shared or production one — before running this.

---

## STEP 3 — Create your .env file

```bash
cp .env.example .env
```
Now open `.env` and fill in the values — see `.env.example` for what each
one is for and which are required vs. optional. **Never commit `.env`** —
it's already in `.gitignore`.

The ones you can't skip: `DATABASE_URL` and `DIRECT_URL` (Step 4), and
`CLERK_SECRET_KEY` (Step 5). `FRONTEND_URL` is also required once this is
running in production — without it, every browser request fails CORS (see
`server.js`'s boot-time check). Everything else degrades gracefully or gates
a specific feature (e.g. no `FIREBASE_SERVICE_ACCOUNT_BASE64` just disables
push notifications).

---

## STEP 4 — Set up a PostgreSQL database

Any Postgres instance works — this app has no provider-specific dependency
in code, just a standard `DATABASE_URL` connection string read by Prisma.
Common options: your hosting provider's managed Postgres (Railway, Render,
etc.), Supabase, or Neon. Whichever you pick, copy its connection string
into `DATABASE_URL`:
```
postgresql://user:password@host:5432/dbname
```

If that connection goes through a pooler (Supabase's Supavisor, PgBouncer,
etc.), also set `DIRECT_URL` to the same database's **direct, non-pooled**
connection string — Prisma's migration commands (`generate`, `db push`,
`migrate`) require it and fail otherwise. On Supabase: Project Settings →
Database → Connection string → "Direct connection" tab. Not using a
pooler? Set `DIRECT_URL` to the same value as `DATABASE_URL`.

---

## STEP 5 — Set up Clerk (Authentication)

1. Go to https://clerk.com → create an application
2. In the Clerk dashboard, grab the **Secret Key** → paste into
   `CLERK_SECRET_KEY` in your `.env`
3. The frontend needs the matching **Publishable Key** (`VITE_CLERK_PUBLISHABLE_KEY`
   in its own `.env`) — see `vtrxfrontend/vtrx-frontend/.env.example`

---

## STEP 6 — Set up Prisma and push the schema

Prisma reads `schema.prisma` and creates the actual database tables. This
project uses `prisma db push` (declarative schema sync), not versioned
migration files.

```bash
npx prisma generate     # Generate the Prisma client
npx prisma db push      # Create/update tables to match schema.prisma
```

To view your database visually in a browser:
```bash
npx prisma studio
# Opens at http://localhost:5555
```

---

## STEP 7 — Get your third-party API keys

See `.env.example` for the full list and what each one gates. At minimum
for local dev you'll likely want:

- **OpenAI** (https://platform.openai.com) → `OPENAI_API_KEY` — set a
  spending limit under Billing → Spend limits
- **Anthropic** (https://console.anthropic.com) → `ANTHROPIC_API_KEY`
- **Stripe** (https://dashboard.stripe.com, test mode) → `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, and your test price IDs

Everything else (Pinecone, Ymove, Supabase, Firebase, Resend, Sentry, n8n,
Linear, Make.com) only needs to be set if you're actively working on that
feature — the app boots fine without them, just with that integration
disabled/logging a warning.

---

## STEP 8 — Start the server

```bash
# Development (auto-restarts when you change files)
npm run dev

# Production
npm start
```

You should see:
```
✅ Database connected
🚀 VTRX API v2.0 on port 5000 [development]
📡 Health: http://localhost:5000/health
```

Test it works:
```bash
curl http://localhost:5000/health
```

---

## STEP 9 — Test the API

Signup/login happen client-side via Clerk's hosted UI (`@clerk/clerk-react`) —
this backend has no `/api/auth/signup` or `/api/auth/login` to curl. To test
an authenticated endpoint, sign in through the frontend and copy the Clerk
session token it sends (DevTools → Network → any `/api/*` request →
`Authorization` header).

Read it into a shell variable rather than pasting it into the command —
`read -s` doesn't echo the input or write it to shell history the way a
literal token in the command line would:
```bash
read -s -p "Paste token: " TOKEN && echo
```

### Get your profile:
```bash
curl http://localhost:5000/api/users/profile \
  -H "Authorization: Bearer $TOKEN"
```

---

## API Endpoints Summary

| Method | Endpoint                          | Auth | Description              |
|--------|-----------------------------------|------|--------------------------|
| GET    | /api/auth/me                      | Yes  | Get current user         |
| POST   | /api/auth/change-password         | Yes  | Change password (Clerk)  |
| GET    | /api/users/profile                | Yes  | Full profile             |
| PUT    | /api/users/profile                | Yes  | Update profile           |
| POST   | /api/users/mood                   | Yes  | Log mood check-in        |
| GET    | /api/users/progress               | Yes  | Progress history         |
| POST   | /api/users/progress               | Yes  | Log measurements         |
| GET    | /api/users/water                  | Yes  | Today's water intake     |
| POST   | /api/users/water                  | Yes  | Log water intake         |
| GET    | /api/users/notifications          | Yes  | Get notifications        |
| GET    | /api/workouts                     | Yes  | Browse workouts          |
| GET    | /api/workouts/:id                 | Yes  | Single workout           |
| POST   | /api/workouts/log                 | Yes  | Log completed workout    |
| GET    | /api/workouts/history              | Yes  | Workout history          |
| GET    | /api/workouts/stats                | Yes  | Weekly stats             |
| GET    | /api/workouts/ai-summary/:logId    | Yes  | AI coaching summary      |
| GET    | /api/nutrition/recipes            | Yes  | Browse recipes           |
| GET    | /api/nutrition/recipes/:id        | Yes  | Single recipe            |
| GET    | /api/nutrition/saved              | Yes  | Saved recipes            |
| POST   | /api/nutrition/saved              | Yes  | Save a recipe            |
| DELETE | /api/nutrition/saved/:id          | Yes  | Unsave a recipe          |
| GET    | /api/nutrition/meal-plan          | Yes* | Today's meal plan        |

*Premium only. This table covers the most commonly used routes — see
`routes/*.js` for the complete list (payments, notifications, AI, uploads,
n8n/Linear webhooks).

---

## Common Beginner Mistakes

**"Cannot connect to database"**
→ Check `DATABASE_URL` format and that your database allows connections
from wherever this is running (IP allowlist / SSL mode, depending on provider)

**"Not authorized" on every request**
→ Make sure you're sending `Authorization: Bearer YOUR_TOKEN` header, and
that the token is a real Clerk session token (not an old JWT — this backend
doesn't issue its own tokens)

**"OpenAI error: Incorrect API key"**
→ Make sure `OPENAI_API_KEY` starts with `sk-` and has billing set up

**Every frontend request fails with a CORS error**
→ `FRONTEND_URL` is unset or doesn't exactly match your deployed frontend's
origin — see the `[CORS]` warning/error in the server logs on boot
