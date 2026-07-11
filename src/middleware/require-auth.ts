import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../http-error.js';
import { verifyJwt } from '../services/auth.service.js';

// OAuth browser redirects can't send Authorization; they use signed connect tokens.
const PUBLIC_PATHS = new Set(['/auth/microsoft/start', '/auth/microsoft/callback']);

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(req.path)) {
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
