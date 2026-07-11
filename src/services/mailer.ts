import nodemailer from 'nodemailer';
import config from '../config.js';

// ponytail: console fallback when SMTP_URL is unset — dev needs no mail server.
const transport = config.smtp.url ? nodemailer.createTransport(config.smtp.url) : null;

async function send(to: string, subject: string, html: string): Promise<void> {
  if (!transport) {
    // eslint-disable-next-line no-console
    console.log(`[email:console] to=${to} subject=${subject}\n${html}`);
    return;
  }
  await transport.sendMail({ from: config.smtp.from, to, subject, html });
}

const link = (path: string, token: string): string =>
  `${config.appBaseUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

export async function sendVerification(to: string, token: string): Promise<void> {
  const url = link('/verify', token);
  await send(
    to,
    'Verify your Religence account',
    `<p>Confirm your email to activate your account.</p><p><a href="${url}">Verify email</a></p><p>Or open: ${url}</p><p>Expires in 24 hours.</p>`
  );
}

export async function sendPasswordReset(to: string, token: string): Promise<void> {
  const url = link('/reset-password', token);
  await send(
    to,
    'Reset your Religence password',
    `<p>We received a request to reset your password.</p><p><a href="${url}">Reset password</a></p><p>Or open: ${url}</p><p>Expires in 1 hour. Ignore if you didn't request it.</p>`
  );
}
