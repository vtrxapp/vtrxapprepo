// ─────────────────────────────────────────────────────────────────────────────
// scripts/cleanupDeviceTokens.js — Dedupe device_tokens
// ─────────────────────────────────────────────────────────────────────────────
// registerToken used to deactivate stale tokens and upsert the new one as two
// separate, non-transactional writes. Concurrent registration calls for the
// same user+platform (routine — the frontend re-registers on every dashboard
// mount) could each find no conflicting row yet and both end up active,
// leaving some accounts with 2+ simultaneously-active tokens for one
// platform. sendToUser fans a push out to every active token, so those
// accounts got every notification delivered twice.
//
// registerToken is now race-safe (advisory-lock-serialized), which stops new
// duplicates, but doesn't retroactively fix rows already left active by the
// old code. Runs on every server startup — no-op once caught up.
// ─────────────────────────────────────────────────────────────────────────────

const prisma = require('../config/database');
const logger = require('../utils/logger');

async function main() {
  const dupGroups = await prisma.$queryRaw`
    SELECT "userId", platform
    FROM device_tokens
    WHERE active = true
    GROUP BY "userId", platform
    HAVING COUNT(*) > 1
  `;

  if (!dupGroups.length) {
    logger.info('Device token cleanup: no duplicate active tokens found.');
    return;
  }

  let deactivated = 0;
  for (const { userId, platform } of dupGroups) {
    const tokens = await prisma.deviceToken.findMany({
      where:   { userId, platform, active: true },
      orderBy: { updatedAt: 'desc' },
    });
    const [, ...stale] = tokens; // keep the most recently updated, deactivate the rest
    if (!stale.length) continue;
    await prisma.deviceToken.updateMany({
      where: { id: { in: stale.map(t => t.id) } },
      data:  { active: false },
    });
    deactivated += stale.length;
  }

  logger.info(`Device token cleanup: deactivated ${deactivated} stale duplicate token(s) across ${dupGroups.length} account(s).`);
}

const run = () => main();
module.exports = { run };

// Allow direct invocation: node scripts/cleanupDeviceTokens.js
if (require.main === module) {
  main().finally(() => prisma.$disconnect()).catch(e => { console.error(e); process.exit(1); });
}
