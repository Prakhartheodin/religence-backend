import mongoose from 'mongoose';

export type UserDoc = {
  userId: string;
  email: string;
  name: string;
  passwordHash: string;
  passwordSalt: string;
  emailVerified: boolean;
  createdAt: Date;
};

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { collection: 'users', versionKey: false }
);

export const UserModel = mongoose.models.User || mongoose.model('User', userSchema);
