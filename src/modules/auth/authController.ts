import { Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import * as authService from './authService';
import { config } from '../../config';
import { memStore } from '../../db/memStore';

export const registerValidation = [
  body('username').isAlphanumeric().isLength({ min: 3, max: 32 }).trim(),
  body('password').isLength({ min: 8 }),
  body('deviceId').isLength({ min: 8, max: 128 }).trim(),
  body('publicKeyB64').isBase64().withMessage('publicKeyB64 must be valid Base64'),
  body('kycTier').optional().isInt({ min: 0, max: 2 }).toInt()
];

export const loginValidation = [
  body('username').notEmpty().trim(),
  body('password').notEmpty(),
  body('deviceId').notEmpty().trim(),
];

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const result = await authService.registerUser(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const result = await authService.loginUser(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// Register / update a device key (called by browser sim for Bob's ephemeral key)
export async function registerDevice(req: Request, res: Response, next: NextFunction) {
  try {
    const { deviceId, publicKeyB64 } = req.body;
    if (!deviceId || !publicKeyB64) {
      return res.status(400).json({ success: false, error: 'deviceId and publicKeyB64 required' });
    }
    const userId = req.user!.sub;
    if (config.isDemoMode) {
      memStore.deviceKeys.set(deviceId, { userId, pubKey: publicKeyB64 });
    } else {
      const { query } = require('../../db/postgres');
      await query(
        `INSERT INTO device_keys (user_id, device_id, public_key_b64)
         VALUES ($1,$2,$3)
         ON CONFLICT (device_id) DO UPDATE SET public_key_b64=EXCLUDED.public_key_b64`,
        [userId, deviceId, publicKeyB64]
      );
    }
    res.json({ success: true, data: { deviceId } });
  } catch (err) {
    next(err);
  }
}
