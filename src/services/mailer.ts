import nodemailer from 'nodemailer';
import config from '../config.js';

// ponytail: console fallback when SMTP_HOST is unset — dev needs no mail server.
const timeoutMs = config.smtp.timeoutS * 1000;
const transport = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465, // implicit TLS on 465, STARTTLS otherwise
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    })
  : null;

type EmailPayload = { to: string; subject: string; html: string; text: string };

async function send(payload: EmailPayload): Promise<void> {
  if (!transport) {
    // eslint-disable-next-line no-console
    console.log(
      `[email:console] to=${payload.to} subject=${payload.subject}\n${payload.text}\n---\n${payload.html}`
    );
    return;
  }
  await transport.sendMail({
    from: config.smtp.from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });
}

const link = (path: string, token: string): string =>
  `${config.appBaseUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

const BRAND = {
  purple: '#7c3aed',
  purpleDeep: '#5b21b6',
  ink: '#0c0a14',
  surface: '#16131f',
  border: '#2a2438',
  text: '#f4f0ff',
  muted: '#a89ec4',
  cream: '#f5efe4',
};

function emailShell(opts: {
  preheader: string;
  eyebrow: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  footerNote: string;
}): { html: string; text: string } {
  const { preheader, eyebrow, title, body, ctaLabel, ctaUrl, footerNote } = opts;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${title}</title>
  <!--[if mso]><style>body,table,td{font-family:Segoe UI,Arial,sans-serif!important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${BRAND.ink};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.ink};padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr>
            <td style="padding-bottom:28px;text-align:center;">
              <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,${BRAND.purple} 0%,${BRAND.purpleDeep} 100%);text-align:center;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#ffffff;">R</td>
                  <td style="padding-left:12px;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:${BRAND.text};text-transform:lowercase;">religence</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:16px;padding:36px 32px 32px;">
              <p style="margin:0 0 8px;font-family:'Segoe UI',system-ui,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.purple};">${eyebrow}</p>
              <h1 style="margin:0 0 16px;font-family:Georgia,'Palatino Linotype','Book Antiqua',serif;font-size:26px;font-weight:600;line-height:1.3;color:${BRAND.text};">${title}</h1>
              <p style="margin:0 0 28px;font-family:'Segoe UI',system-ui,sans-serif;font-size:16px;line-height:1.6;color:${BRAND.muted};">${body}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="border-radius:10px;background:linear-gradient(135deg,${BRAND.purple} 0%,${BRAND.purpleDeep} 100%);">
                    <a href="${ctaUrl}" style="display:inline-block;padding:14px 28px;font-family:'Segoe UI',system-ui,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${ctaLabel}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5;color:${BRAND.muted};">If the button doesn't work, copy this link into your browser:</p>
              <p style="margin:0;padding:12px 14px;background-color:${BRAND.ink};border:1px solid ${BRAND.border};border-radius:8px;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.5;word-break:break-all;color:${BRAND.cream};"><a href="${ctaUrl}" style="color:${BRAND.cream};text-decoration:underline;">${ctaUrl}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 8px 0;text-align:center;font-family:'Segoe UI',system-ui,sans-serif;font-size:12px;line-height:1.6;color:${BRAND.muted};">
              ${footerNote}<br />
              <span style="color:${BRAND.border};">—</span><br />
              Religence · Pharma CRM
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${title}

${body}

${ctaLabel}: ${ctaUrl}

${footerNote}

— Religence · Pharma CRM`;

  return { html, text };
}

export async function sendVerification(to: string, token: string): Promise<void> {
  const url = link('/verify', token);
  const { html, text } = emailShell({
    preheader: 'Confirm your email to activate your Religence account.',
    eyebrow: 'Account activation',
    title: 'Verify your email',
    body: 'Welcome to Religence. Confirm your email address to unlock your CRM workspace and start managing leads.',
    ctaLabel: 'Verify email address',
    ctaUrl: url,
    footerNote: 'This link expires in 24 hours. If you didn\'t create an account, you can ignore this email.',
  });
  await send({ to, subject: 'Verify your Religence account', html, text });
}

export async function sendPasswordReset(to: string, token: string): Promise<void> {
  const url = link('/reset-password', token);
  const { html, text } = emailShell({
    preheader: 'Reset your Religence password.',
    eyebrow: 'Password reset',
    title: 'Reset your password',
    body: 'We received a request to reset your password. Choose a new one to regain access to your account.',
    ctaLabel: 'Reset password',
    ctaUrl: url,
    footerNote: 'This link expires in 1 hour. If you didn\'t request a reset, you can safely ignore this email.',
  });
  await send({ to, subject: 'Reset your Religence password', html, text });
}
