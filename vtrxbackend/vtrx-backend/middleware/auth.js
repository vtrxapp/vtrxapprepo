const { verifyToken, createClerkClient } = require('@clerk/backend');
const prisma  = require('../config/database');
const logger  = require('../utils/logger');

const USER_SELECT = {
  id:           true,
  email:        true,
  username:     true,
  name:         true,
  isPremium:    true,
  cognitoId:    true,
  goal:         true,
  fitnessLevel: true,
  streakDays:   true,
  daysPerWeek:  true,
  equipment:    true,
  location:     true,
  subscription: { select: { status: true, plan: true, currentPeriodEnd: true } },
};

// Lazily-created Clerk client (avoids crashing on import if key missing at module load)
let _clerkClient = null;
const getClerkClient = () => {
  if (!_clerkClient) _clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  return _clerkClient;
};

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authorised — no token provided' });
    }
    const token = authHeader.split(' ')[1];

    // Verify Clerk session token
    let payload;
    try {
      payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    const clerkUserId = payload.sub;

    // Look up Prisma user by Clerk user ID (stored in cognitoId column)
    let user = await prisma.user.findUnique({ where: { cognitoId: clerkUserId }, select: USER_SELECT });

    // Auto-provision: first request after Clerk signup creates the Prisma user
    if (!user) {
      let clerkUser;
      try {
        clerkUser = await getClerkClient().users.getUser(clerkUserId);
      } catch (err) {
        logger.warn(`Could not fetch Clerk user ${clerkUserId}: ${err.message}`);
      }
      const email    = clerkUser?.emailAddresses?.[0]?.emailAddress || payload.email || '';
      const name     = [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(' ') || '';
      const username = ((clerkUser?.username || email.split('@')[0] || 'user')
        .replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20)) || clerkUserId.slice(0, 15);

      // Try creating with the base username, then append suffix on conflict
      const baseUsername = username;
      let createAttempts = 0;
      while (createAttempts < 3) {
        const tryUsername = createAttempts === 0 ? baseUsername : `${baseUsername.slice(0, 16)}_${clerkUserId.slice(-3)}`;
        try {
          user = await prisma.user.create({ data: { cognitoId: clerkUserId, email, name, username: tryUsername }, select: USER_SELECT });
          logger.info(`Auto-provisioned Prisma user for Clerk ${clerkUserId} (${email})`);
          break;
        } catch (e) {
          if (e.code === 'P2002') {
            const target = e.meta?.target;
            // Username conflict — retry with suffix
            if (Array.isArray(target) && target.includes('username')) { createAttempts++; continue; }
            // cognitoId/email conflict — another request already created this user
            user = await prisma.user.findFirst({
              where: { OR: [{ cognitoId: clerkUserId }, ...(email ? [{ email }] : [])] },
              select: USER_SELECT,
            });
            break;
          }
          throw e;
        }
      }
    }

    if (!user) {
      return res.status(401).json({ success: false, message: 'User could not be found or created' });
    }

    // Revoke expired premium
    if (user.subscription) {
      const sub = user.subscription;
      const active = sub.status === 'active' && (!sub.currentPeriodEnd || sub.currentPeriodEnd > new Date());
      if (!active && user.isPremium) {
        prisma.user.update({ where: { id: user.id }, data: { isPremium: false } }).catch(() => {});
        user.isPremium = false;
      }
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const requirePremium = (req, res, next) => {
  if (!req.user?.isPremium) {
    return res.status(403).json({ success: false, message: 'This feature requires a Premium subscription', code: 'PREMIUM_REQUIRED' });
  }
  next();
};

module.exports = { protect, requirePremium };
