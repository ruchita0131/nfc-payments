import { Request, Response, NextFunction } from 'express';
import { logger } from '../db/logger';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  if (statusCode >= 500) {
    logger.error('Unhandled error', { message, stack: err.stack, path: req.path });
  } else {
    logger.warn('Request error', { message, statusCode, path: req.path });
  }

  res.status(statusCode).json({ success: false, error: message });
}
