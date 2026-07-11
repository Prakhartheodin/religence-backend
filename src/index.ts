import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import config from './config.js';
import { connectMongo } from './db/mongo.js';
import { HttpError } from './http-error.js';
import { requireAuth } from './middleware/require-auth.js';
import { authRouter } from './routes/auth.routes.js';
import { crmRouter } from './routes/crm.routes.js';
import { emailRouter } from './routes/email.routes.js';
import { masterDataRouter } from './routes/master-data.routes.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
// CRM entity lists (leads/timeline) can exceed the 100kb default as they grow.
app.use(express.json({ limit: '5mb' }));
app.use('/v1/auth', authRouter);
app.use('/v1/email', emailRouter);
app.use('/v1/master-data', requireAuth, masterDataRouter);
app.use('/v1/crm', requireAuth, crmRouter);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'religence-backend',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      details: err.details,
    });
  }
  const unknownErr = err as { message?: string };
  return res.status(500).json({
    error: unknownErr.message ?? 'Internal server error',
  });
});

async function startServer(): Promise<void> {
  try {
    await connectMongo();
    const server = app.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`[religence-backend] listening on http://localhost:${config.port}`);
    });

    server.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[religence-backend] HTTP server failed:', err);
      process.exit(1);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[religence-backend] Startup failed:', err);
    process.exit(1);
  }
}

void startServer();
