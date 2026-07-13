import dotenv from 'dotenv';

dotenv.config();

const port = Number(process.env.PORT ?? 4000);

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port,
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  demoUserId: process.env.DEMO_USER_ID ?? 'demo-user',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  mongodbUri: (process.env.MONGODB_URI ?? '').trim(),
  masterDataExcelDir: (process.env.MASTER_DATA_EXCEL_DIR ?? '').trim(),
  jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
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
};

export default config;
