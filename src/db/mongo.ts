import mongoose from 'mongoose';
import config from '../config.js';

let connectionPromise: Promise<typeof mongoose> | null = null;
let listenersBound = false;

function bindConnectionLogs(): void {
  if (listenersBound) return;
  listenersBound = true;

  mongoose.connection.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[religence-backend] MongoDB connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    // eslint-disable-next-line no-console
    console.warn('[religence-backend] MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    // eslint-disable-next-line no-console
    console.log('[religence-backend] MongoDB reconnected');
  });
}

export async function connectMongo(): Promise<void> {
  const uri = config.mongodbUri;
  if (!uri) {
    throw new Error('Missing MONGODB_URI in backend environment.');
  }

  bindConnectionLogs();

  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (!connectionPromise) {
    // eslint-disable-next-line no-console
    console.log('[religence-backend] Connecting to MongoDB...');
    connectionPromise = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 10_000,
      })
      .then((conn) => {
        // eslint-disable-next-line no-console
        console.log(
          `[religence-backend] MongoDB connected (${conn.connection.host}:${conn.connection.port})`
        );
        return conn;
      })
      .catch((err) => {
        connectionPromise = null;
        throw err;
      });
  }

  await connectionPromise;
}
