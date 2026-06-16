import { Request, Response, NextFunction } from 'express';
import { body, query as queryValidator, validationResult } from 'express-validator';
import * as reconciliationService from './reconciliationService';

export const syncValidation = [
  body('transactions').isArray({ min: 1, max: 100 }).withMessage('transactions must be a non-empty array (max 100)'),
  body('transactions.*.clientTxnId').isUUID().withMessage('clientTxnId must be a UUID'),
  body('transactions.*.amountPaise').isInt({ min: 1 }),
  body('transactions.*.counter').isInt({ min: 0 }),
  body('transactions.*.nonce').isLength({ min: 8, max: 128 }),
  body('transactions.*.payerHmac').notEmpty(),
  body('transactions.*.tappedAt').isISO8601(),
  body('transactions.*.nfcPayload').isObject(),
];

export async function syncTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = req.user!.sub;
    const transactions = req.body.transactions.map((t: any) => ({
      ...t,
      payerUserId: userId,
    }));

    const results = await reconciliationService.reconcileTransactions(transactions);
    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
}

export async function getHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.sub;
    const limit = parseInt(req.query.limit as string || '50', 10);
    const offset = parseInt(req.query.offset as string || '0', 10);

    const history = await reconciliationService.getTransactionHistory(userId, limit, offset);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
}

export async function getDashboardStats(req: Request, res: Response, next: NextFunction) {
  try {
    const stats = await reconciliationService.getDashboardStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
}
