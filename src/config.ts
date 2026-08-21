import dotenv from 'dotenv';
import { normalizeBaseUrl } from './lib/normalize-url.js';

dotenv.config();

const port = Number(process.env.PORT ?? 4000);
const localDefault = 'http://localhost:3000';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port,
  corsOrigin: normalizeBaseUrl(process.env.CORS_ORIGIN, localDefault),
  appBaseUrl: normalizeBaseUrl(process.env.APP_BASE_URL, localDefault),
  mongodbUri: (process.env.MONGODB_URI ?? '').trim(),
  masterDataExcelDir: (process.env.MASTER_DATA_EXCEL_DIR ?? '').trim(),
  jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
  tokenEncKey: (process.env.TOKEN_ENC_KEY ?? '').trim(),
  smtp: {
    host: (process.env.SMTP_HOST ?? '').trim(),
    port: Number(process.env.SMTP_PORT ?? 465),
    // Seconds. Gmail on a cold connection needs a few; keep it short so a bad
    // host fails fast instead of hanging the register/reset request.
    timeoutS: Number(process.env.SMTP_TIMEOUT ?? 10),
    user: process.env.SMTP_USERNAME ?? '',
    pass: process.env.SMTP_PASSWORD ?? '',
    from: process.env.EMAIL_FROM ?? 'Religence <no-reply@religence.local>',
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.MICROSOFT_REDIRECT_URI ??
      `http://localhost:${port}/v1/email/auth/microsoft/callback`,
    tenantId: process.env.MICROSOFT_TENANT_ID ?? 'common',
  },
  workflowTimezone: process.env.WORKFLOW_TIMEZONE?.trim() || 'Asia/Kolkata',
  mail: {
    /** Tenant external-recipient daily limit (TERRL) when known; send-guard uses 80% of this. */
    tenantExternalRecipientLimit: (() => {
      const raw = (process.env.MAIL_TENANT_EXTERNAL_RECIPIENT_LIMIT ?? '').trim();
      const n = Number(raw);
      return raw && Number.isFinite(n) && n > 0 ? n : null;
    })(),
  },
  chatLlm: {
    apiKey: (process.env.OPENAI_API_KEY ?? '').trim(),
    baseUrl: (process.env.CHAT_LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: (process.env.OPENAI_MODEL ?? 'gpt-4o-mini').trim(),
  },
};

export default config;
