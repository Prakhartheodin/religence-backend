import { Router } from 'express';
import * as auth from '../services/auth.service.js';

export const authRouter = Router();

const str = (v: unknown): string => String(v ?? '').trim();

authRouter.post('/register', async (req, res, next) => {
  try {
    await auth.register(
      str(req.body.name),
      str(req.body.email),
      String(req.body.password ?? ''),
      String(req.body.confirmPassword ?? '')
    );
    res.status(201).json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/verify', (req, res, next) => {
  try {
    auth.verifyEmail(str(req.body.token));
    res.json({ status: 'verified' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', (req, res, next) => {
  try {
    res.json(auth.login(str(req.body.email), String(req.body.password ?? '')));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/resend-verification', async (req, res, next) => {
  try {
    await auth.resendVerification(str(req.body.email));
    res.json({ status: 'ok' }); // always 200
  } catch (err) {
    next(err);
  }
});

authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    await auth.forgotPassword(str(req.body.email));
    res.json({ status: 'ok' }); // always 200
  } catch (err) {
    next(err);
  }
});

authRouter.post('/reset-password', (req, res, next) => {
  try {
    auth.resetPassword(str(req.body.token), String(req.body.password ?? ''));
    res.json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
});
