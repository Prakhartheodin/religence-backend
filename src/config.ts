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
  storageConnectionString: (process.env.STORAGE_CONNECTION_STRING ?? '').trim(),
  masterDataExcelDir: (process.env.MASTER_DATA_EXCEL_DIR ?? '').trim(),
  jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
  smtp: {
    url: process.env.SMTP_URL ?? '', // e.g. smtp://user:pass@smtp.example.com:587
    from: process.env.AUTH_EMAIL_FROM ?? 'Religence <no-reply@religence.local>',
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
