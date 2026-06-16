import { Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import * as walletService from './walletService';

export const loadValidation = [
  body('amountPaise')
    .isInt({ min: 1, max: 1_000_000 })
    .withMessage('amountPaise must be a positive integer (paise). ₹10 = 1000'),
  body('deviceId').notEmpty().trim(),
  body('sessionPublicKey').notEmpty().withMessage('sessionPublicKey (Base64 ECDSA pubkey) required'),
];

export async function getBalance(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.sub;
    const result = await walletService.getBalance(userId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function loadWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = req.user!.sub;
    const kycTier = (req.user as any).kycTier || 0;
    const { amountPaise, deviceId, sessionPublicKey } = req.body;

    const result = await walletService.loadWallet(userId, amountPaise, deviceId, sessionPublicKey, kycTier);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getToken(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.sub;
    const deviceId = req.query.deviceId as string;
    const sessionPublicKey = req.query.sessionPublicKey as string;
    const kycTier = (req.user as any).kycTier || 0;

    if (!deviceId || !sessionPublicKey) {
      return res.status(400).json({ success: false, error: 'deviceId and sessionPublicKey required' });
    }

    const token = await walletService.getCurrentToken(userId, deviceId, sessionPublicKey, kycTier);
    if (!token) {
      return res.status(404).json({ success: false, error: 'No valid token. Load wallet first.' });
    }
    res.json({ success: true, data: token });
  } catch (err) {
    next(err);
  }
}
