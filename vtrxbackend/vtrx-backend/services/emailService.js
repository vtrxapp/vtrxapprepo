const { Resend } = require('resend');
const logger     = require('../utils/logger');

let _resend = null;
const getClient = () => {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      logger.warn('RESEND_API_KEY not set — email sending disabled');
      return null;
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
};

const FROM = process.env.RESEND_FROM_EMAIL || 'VTRX <onboarding@resend.dev>';

// Destination for user-submitted support messages — falls back to FROM (the
// same address already configured for outbound mail) so this feature works
// without requiring a second env var to be set up.
const SUPPORT_TO = process.env.SUPPORT_EMAIL || FROM;

const escapeHtml = (str) => String(str)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// ── Welcome email ─────────────────────────────────────────────────────────────
const sendWelcomeEmail = async ({ email, name }) => {
  const client = getClient();
  if (!client) return;

  const displayName = name || 'Athlete';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Welcome to VTRX</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <div style="display:inline-block;background:linear-gradient(135deg,#00A3FF,#0068CC);border-radius:16px;padding:14px 28px;">
                <span style="font-family:'Helvetica Neue',Arial,sans-serif;font-weight:900;font-size:28px;color:#ffffff;letter-spacing:3px;">VTRX</span>
              </div>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#111111;border-radius:24px;border:1px solid #1e1e1e;padding:48px 40px;">

              <!-- Headline -->
              <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#00A3FF;letter-spacing:2px;text-transform:uppercase;">Welcome aboard</p>
              <h1 style="margin:0 0 20px;font-size:32px;font-weight:900;color:#ffffff;line-height:1.2;">Hey ${displayName}, let's get to work. 💪</h1>
              <p style="margin:0 0 32px;font-size:16px;color:#888888;line-height:1.7;">
                Your VTRX account is ready. You now have access to AI-powered coaching, personalised workout plans, and everything you need to hit your goals.
              </p>

              <!-- Divider -->
              <div style="height:1px;background:#1e1e1e;margin-bottom:32px;"></div>

              <!-- Feature list -->
              <p style="margin:0 0 16px;font-size:14px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">Here's what's waiting for you:</p>
              ${[
                ['🏋️', 'Workout Library',     'Hundreds of guided workouts from beginner to elite'],
                ['🤖', 'AI Coaching',          'Personal recap and coaching insights after every session'],
                ['🥗', 'Smart Nutrition',      'Daily meal plans and grocery lists tailored to your goal'],
                ['📈', 'Progress Tracking',    'Streak tracking, PRs, and weekly performance reports'],
              ].map(([icon, title, desc]) => `
              <table cellpadding="0" cellspacing="0" style="margin-bottom:16px;width:100%;">
                <tr>
                  <td style="width:44px;vertical-align:top;">
                    <div style="width:40px;height:40px;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:12px;text-align:center;line-height:40px;font-size:18px;">${icon}</div>
                  </td>
                  <td style="padding-left:14px;vertical-align:top;">
                    <p style="margin:0 0 2px;font-size:14px;font-weight:700;color:#ffffff;">${title}</p>
                    <p style="margin:0;font-size:13px;color:#666666;line-height:1.5;">${desc}</p>
                  </td>
                </tr>
              </table>`).join('')}

              <!-- Divider -->
              <div style="height:1px;background:#1e1e1e;margin:32px 0;"></div>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="https://vtrxapp.com" style="display:inline-block;padding:16px 48px;background:linear-gradient(135deg,#00A3FF,#0068CC);border-radius:50px;font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;letter-spacing:0.5px;">Open VTRX →</a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:32px;">
              <p style="margin:0;font-size:12px;color:#333333;line-height:1.8;">
                You're receiving this because you created a VTRX account.<br/>
                © ${new Date().getFullYear()} VTRX · All rights reserved
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const { data, error } = await client.emails.send({
      from:    FROM,
      to:      email,
      subject: `Welcome to VTRX, ${displayName} 🏋️`,
      html,
    });
    if (error) {
      logger.warn(`Welcome email failed for ${email}: ${error.message}`);
    } else {
      logger.info(`Welcome email sent to ${email} (id: ${data?.id})`);
    }
  } catch (err) {
    logger.warn(`Welcome email error for ${email}: ${err.message}`);
  }
};

// ── Support message ───────────────────────────────────────────────────────────
// Unlike sendWelcomeEmail (best-effort, failures are swallowed since nothing
// depends on it), this one throws on failure — the caller needs to know
// whether the message actually went out before telling the user it did.
const sendSupportMessage = async ({ userEmail, userName, userId, message }) => {
  const client = getClient();
  if (!client) throw new Error('Email sending is not configured');

  const displayName = userName || userEmail || 'A user';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#111111;border-radius:24px;border:1px solid #1e1e1e;padding:40px;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#00A3FF;letter-spacing:2px;text-transform:uppercase;">Support message</p>
              <h1 style="margin:0 0 20px;font-size:22px;font-weight:900;color:#ffffff;">From ${escapeHtml(displayName)}</h1>
              <p style="margin:0 0 4px;font-size:13px;color:#888888;">Email: ${escapeHtml(userEmail || 'unknown')}</p>
              <p style="margin:0 0 20px;font-size:13px;color:#888888;">User ID: ${escapeHtml(userId || 'unknown')}</p>
              <div style="height:1px;background:#1e1e1e;margin-bottom:20px;"></div>
              <p style="margin:0;font-size:15px;color:#ffffff;line-height:1.6;white-space:pre-wrap;">${escapeHtml(message)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const { data, error } = await client.emails.send({
    from:    FROM,
    to:      SUPPORT_TO,
    replyTo: userEmail || undefined,
    subject: `Support message from ${displayName}`,
    html,
  });
  if (error) throw new Error(error.message || 'Failed to send support message');
  return { id: data?.id };
};

module.exports = { sendWelcomeEmail, sendSupportMessage };
