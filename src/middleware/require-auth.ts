import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../http-error.js';
import { verifyJwt } from '../services/auth.service.js';

// Browser-navigation OAuth routes can't send an Authorization header; they
// carry the user id in the query/state instead, so they stay public.
const PUBLIC_PREFIXES = ['/auth/microsoft'];

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS' || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) {
    return next();
  }
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return next(new HttpError(401, 'authentication required'));
  try {
    (req as Request & { userId?: string }).userId = verifyJwt(token);
    next();
  } catch {
    next(new HttpError(401, 'invalid or expired token'));
  }
}
