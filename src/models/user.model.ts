import mongoose from 'mongoose';

export type UserDoc = {
  userId: string;
  email: string;
  name: string;
  passwordHash: string;
  passwordSalt: string;
  emailVerified: boolean;
  createdAt: string;
};

const userSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    createdAt: { type: String, required: true },
  },
  { collection: 'users' }
);

export const UserModel = mongoose.models.User || mongoose.model('User', userSchema);
