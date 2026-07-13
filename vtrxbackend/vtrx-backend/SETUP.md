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
│   ├── aws.js                   ← AWS SDK setup (Cognito, Secrets Manager)
│   └── database.js              ← Prisma database client
│
├── prisma/
│   └── schema.prisma            ← Your entire database structure
│
├── middleware/
│   ├── auth.js                  ← JWT token verification
│   └── errorHandler.js          ← Catches all errors cleanly
│
├── services/
│   ├── cognitoService.js        ← AWS Cognito (signup, login, etc)
│   ├── aiService.js             ← OpenAI workout summaries
│   └── ymoveService.js          ← Ymove content integration
│
├── controllers/
│   ├── authController.js        ← Auth business logic
│   ├── workoutController.js     ← Workout & logging logic
│   ├── userController.js        ← Profile & progress logic
│   └── nutritionController.js   ← Recipe & meal plan logic
│
├── routes/
│   ├── auth.js                  ← /api/auth/* endpoints
│   ├── users.js                 ← /api/users/* endpoints
│   ├── workouts.js              ← /api/workouts/* endpoints
│   └── nutrition.js             ← /api/nutrition/* endpoints
│
└── utils/
    └── logger.js                ← CloudWatch-ready logging
```

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
This downloads all the packages listed in package.json.
It creates a `node_modules` folder (never commit this to git — it's huge).

---

## STEP 3 — Create your .env file

```bash
cp .env.example .env
```
Now open `.env` and fill in the values one section at a time.
**NEVER commit this file to git.** It's already in .gitignore.

---

## STEP 4 — Set up AWS Cognito (Authentication)

**Why Cognito?** It handles user accounts, password hashing, email verification,
and token generation — all securely, without you writing any crypto code.

### 4a — Create a User Pool

1. Go to AWS Console → search "Cognito" → click "User Pools"
2. Click "Create user pool"
3. Settings to choose:
   - **Sign-in options:** Email
   - **Password policy:** Cognito defaults (min 8 chars, uppercase, lowercase, number)
   - **MFA:** Optional (skip for now)
   - **Email verification:** Yes (sends code automatically)
   - **App client name:** `vtrx-app`
   - **App client type:** Public client
   - **Auth flows:** Enable `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`

4. After creation, note down:
   - **User Pool ID** (looks like: `us-east-1_AbCdEfGhI`) → paste into `COGNITO_USER_POOL_ID`
   - **App Client ID** (looks like: `1a2b3c4d5e6f...`) → paste into `COGNITO_CLIENT_ID`
   - If your client has a secret, paste into `COGNITO_CLIENT_SECRET` (leave blank if none)

### 4b — Create an IAM user for local development

1. AWS Console → IAM → Users → Create User
2. Name: `vtrx-local-dev`
3. Attach policies: `AmazonCognitoFullAccess`
4. Create access keys → copy into `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`

> ⚠️ In production (AWS Lambda/EC2), you use IAM roles, NOT access keys.
> Access keys are for local development only.

---

## STEP 5 — Set up AWS RDS PostgreSQL (Database)

**Why RDS?** It's a managed PostgreSQL database hosted by AWS.
You don't have to worry about backups, patches, or scaling.

1. AWS Console → RDS → Create database
2. Engine: **PostgreSQL**
3. Template: **Free tier** (for development)
4. Settings:
   - DB identifier: `vtrx-db`
   - Username: `vtrx_user`
   - Password: (create a strong one, save it)
5. Instance: `db.t3.micro` (free tier)
6. Storage: 20GB (default)
7. Connectivity:
   - Public access: **Yes** (for local development only — turn off in production)
   - VPC security group: Create new → allow inbound PostgreSQL (port 5432) from your IP

8. After creation, copy the **Endpoint** from the RDS console.

Build your DATABASE_URL:
```
postgresql://vtrx_user:yourpassword@your-endpoint.rds.amazonaws.com:5432/vtrx_db
```

---

## STEP 6 — Set up Prisma and run migrations

Prisma reads your schema.prisma and creates the actual database tables.

```bash
# Generate the Prisma client (do this after any schema changes)
npm run db:generate

# Create the tables in your database (first time setup)
npm run db:migrate -- --name initial_setup
```

To view your database visually in a browser:
```bash
npm run db:studio
# Opens at http://localhost:5555
```

---

## STEP 7 — Get your OpenAI API key

1. Go to https://platform.openai.com
2. Create account → API Keys → Create new key
3. Copy it into `OPENAI_API_KEY` in your .env
4. Add a spending limit (Settings → Billing → Spend limits) — recommended: $10/month to start

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
🚀 VTRX API running on port 5000 [development]
📡 Health check: http://localhost:5000/health
```

Test it works:
```bash
curl http://localhost:5000/health
```

---

## STEP 9 — Test the API

Signup/login happen client-side via Clerk's hosted UI (`@clerk/clerk-react`) —
this backend has no `/api/auth/signup` or `/api/auth/login` to curl. To test
an authenticated endpoint, sign in through the frontend, copy the Clerk
session token it sends (DevTools → Network → any `/api/*` request →
`Authorization` header), and use that as `YOUR_TOKEN_HERE` below.

### Get your profile:
```bash
curl http://localhost:5000/api/users/profile \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
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
| GET    | /api/users/notifications          | Yes  | Get notifications        |
| GET    | /api/workouts                     | Yes  | Browse workouts          |
| GET    | /api/workouts/:id                 | Yes  | Single workout           |
| POST   | /api/workouts/log                 | Yes  | Log completed workout    |
| GET    | /api/workouts/history             | Yes  | Workout history          |
| GET    | /api/workouts/stats               | Yes  | Weekly stats             |
| GET    | /api/workouts/ai-summary/:logId   | Yes  | AI coaching summary      |
| GET    | /api/nutrition/recipes            | Yes  | Browse recipes           |
| GET    | /api/nutrition/recipes/:id        | Yes  | Single recipe            |
| GET    | /api/nutrition/saved              | Yes  | Saved recipes            |
| POST   | /api/nutrition/saved              | Yes  | Save a recipe            |
| DELETE | /api/nutrition/saved/:id          | Yes  | Unsave a recipe          |
| GET    | /api/nutrition/meal-plan          | Yes* | Today's meal plan        |

*Premium only

---

## Common Beginner Mistakes

**"Cannot connect to database"**
→ Check DATABASE_URL format, make sure RDS security group allows your IP

**"Not authorized" on every request**
→ Make sure you're sending `Authorization: Bearer YOUR_TOKEN` header

**"Cognito error: UserPool not found"**
→ Check COGNITO_USER_POOL_ID matches your AWS region prefix

**"OpenAI error: Incorrect API key"**
→ Make sure OPENAI_API_KEY starts with `sk-` and has billing set up

---

## Next Steps (Phase 2)

1. Connect your React frontend to these APIs
2. Set up AWS Amplify for frontend hosting
3. Configure AWS S3 + CloudFront for media
4. Set up AWS Secrets Manager for production secrets
5. Add Ymove API once you have their documentation
