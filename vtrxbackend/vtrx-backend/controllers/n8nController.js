const prisma  = require('../config/database');
const logger   = require('../utils/logger');
const { sendWelcomeEmail } = require('../services/emailService');

// Verify shared secret so only n8n can call these endpoints
const verifySecret = (req, res) => {
  const secret = req.headers['x-n8n-secret'];
  if (!process.env.N8N_WEBHOOK_SECRET || secret !== process.env.N8N_WEBHOOK_SECRET) {
    res.status(401).json({ success: false, message: 'Unauthorised' });
    return false;
  }
  return true;
};

// POST /api/n8n/send-welcome
// n8n calls this after adding a user to Mailchimp to also send the Resend welcome email
const sendWelcome = async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'email required' });
  await sendWelcomeEmail({ email, name }).catch(() => {});
  res.json({ success: true });
};

// POST /api/n8n/tag-premium
// n8n calls this after a Stripe checkout to mark user premium in our DB immediately
const tagPremium = async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'email required' });
  try {
    const updated = await prisma.user.updateMany({
      where: { email: email.toLowerCase() },
      data:  { isPremium: true },
    });
    logger.info(`n8n tagPremium: ${email} (${updated.count} row(s) updated)`);
    res.json({ success: true, updated: updated.count });
  } catch (err) {
    logger.error('n8n tagPremium error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/n8n/send-notification
// n8n calls this to trigger an in-app notification for a user
const sendNotification = async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { email, title, body, type = 'n8n_trigger' } = req.body;
  if (!email || !title || !body) {
    return res.status(400).json({ success: false, message: 'email, title, body required' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await prisma.notification.create({
      data: { userId: user.id, type, title, body },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('n8n sendNotification error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { sendWelcome, tagPremium, sendNotification };
