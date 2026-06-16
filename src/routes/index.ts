import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as authController from '../modules/auth/authController';
import * as walletController from '../modules/wallet/walletController';
import * as transactionController from '../modules/transaction/transactionController';

const router = Router();

// ─── Health ────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Auth ──────────────────────────────────────────────────
router.post('/auth/register', authController.registerValidation, authController.register);
router.post('/auth/login', authController.loginValidation, authController.login);
// Register a device key (used by browser sim to inject Bob's ephemeral ECDSA key)
router.post('/auth/register-device', authenticate, authController.registerDevice);

// ─── Wallet (protected) ────────────────────────────────────
router.get('/wallet/balance', authenticate, walletController.getBalance);
router.post('/wallet/load', authenticate, walletController.loadValidation, walletController.loadWallet);
router.get('/wallet/token', authenticate, walletController.getToken);

// ─── Transactions (protected) ──────────────────────────────
router.post('/transactions/sync', authenticate, transactionController.syncValidation, transactionController.syncTransactions);
router.get('/transactions/history', authenticate, transactionController.getHistory);

// ─── Dashboard (stats — no auth for demo purposes) ─────────
router.get('/dashboard/stats', transactionController.getDashboardStats);

export default router;
