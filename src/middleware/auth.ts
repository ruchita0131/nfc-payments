import { Request, Response, NextFunction } from 'express';
import { verifyJWT } from '../modules/auth/authService';

declare global {
  namespace Express {
    interface Request {
      user?: { sub: string; username: string; kycTier: number };
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing Bearer token' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyJWT(token);
    req.user = { sub: payload.sub, username: payload.username, kycTier: payload.kycTier };
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}
