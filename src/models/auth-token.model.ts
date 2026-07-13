import mongoose from 'mongoose';

/** 'verify-consumed' remembers a used verify token so duplicate requests stay idempotent. */
export type AuthTokenPurpose = 'verify' | 'reset' | 'verify-consumed';

export type AuthTokenDoc = {
  tokenHash: string;
  userId: string;
  purpose: AuthTokenPurpose;
  expiresAt: Date;
};

const authTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    userId: { type: String, required: true },
    purpose: { type: String, required: true, enum: ['verify', 'reset', 'verify-consumed'] },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'auth_tokens' }
);

authTokenSchema.index({ tokenHash: 1, purpose: 1 });
// Mongo reaps expired tokens on its own — no prune code needed.
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthTokenModel =
  mongoose.models.AuthToken || mongoose.model('AuthToken', authTokenSchema);
