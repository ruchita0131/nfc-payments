import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { logger } from '../../db/logger';
import { memStore } from '../../db/memStore';
import {
  buildTokenPayload,
  signToken,
  SignedToken,
} from '../token/tokenService';

function getOfflineLimitPaise(kycTier: number): number {
  if (kycTier === 2) return 500000; // ₹5000
  if (kycTier === 1) return 200000; // ₹2000
  return 50000;                     // ₹500
}

// ─── Get Balance ──────────────────────────────────────────────
export async function getBalance(userId: string): Promise<{
  balancePaise: number;
  balanceRupees: string;
}> {
  if (config.isDemoMode) {
    const balancePaise = memStore.wallets.get(userId) ?? 0;
    return { balancePaise, balanceRupees: formatRupees(balancePaise) };
  }

  const { query } = require('../../db/postgres');
  const result = await query('SELECT balance_paise FROM wallets WHERE user_id = $1', [userId]);
  if (!result.rows.length) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });
  const balancePaise = parseInt(result.rows[0].balance_paise, 10);
  return { balancePaise, balanceRupees: formatRupees(balancePaise) };
}

// ─── Load / Top-Up ────────────────────────────────────────────
export async function loadWallet(
  userId: string,
  amountPaise: number,
  deviceId: string,
  sessionPublicKey: string,
  kycTier: number = 0
): Promise<{ balancePaise: number; balanceRupees: string; token: SignedToken }> {
  if (amountPaise <= 0 || amountPaise > 1_000_000) {
    throw Object.assign(new Error('Amount must be between ₹0.01 and ₹10,000'), { statusCode: 400 });
  }

  if (config.isDemoMode) {
    // ── Demo: in-memory ──────────────────────────────────────
    const current = memStore.wallets.get(userId) ?? 0;
    const newBalance = current + amountPaise;
    memStore.wallets.set(userId, newBalance);

    // Determine next counter
    const existing = memStore.tokens.get(userId);
    const newCounter = (existing?.counter ?? 0) + 1;
    const limitPaise = getOfflineLimitPaise(kycTier);

    const payload = buildTokenPayload(userId, deviceId, sessionPublicKey, newBalance, limitPaise, newCounter);
    const signed = signToken(payload);
    memStore.tokens.set(userId, signed);

    logger.info('Wallet loaded (demo)', { userId, amountPaise, newBalance, counter: newCounter });
    return { balancePaise: newBalance, balanceRupees: formatRupees(newBalance), token: signed };
  }

  // ── Production: PostgreSQL ────────────────────────────────
  const { withTransaction } = require('../../db/postgres');
  return withTransaction(async (client: any) => {
    const walletResult = await client.query(
      'UPDATE wallets SET balance_paise = balance_paise + $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance_paise',
      [amountPaise, userId]
    );
    if (!walletResult.rows.length) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });
    const newBalance = parseInt(walletResult.rows[0].balance_paise, 10);

    await client.query('UPDATE offline_tokens SET revoked = TRUE WHERE user_id = $1', [userId]);
    const counterResult = await client.query(
      'SELECT COALESCE(MAX(counter), 0) as counter FROM offline_tokens WHERE user_id = $1', [userId]
    );
    const newCounter = parseInt(counterResult.rows[0]?.counter || '0', 10) + 1;

    const limitPaise = getOfflineLimitPaise(kycTier);

    const payload = buildTokenPayload(userId, deviceId, sessionPublicKey, newBalance, limitPaise, newCounter);
    const signed = signToken(payload);

    await client.query(
      `INSERT INTO offline_tokens (user_id, issued_balance_paise, offline_limit_paise, counter, expires_at, hmac) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, newBalance, limitPaise, newCounter, signed.expiresAt, signed.hmac]
    );
    return { balancePaise: newBalance, balanceRupees: formatRupees(newBalance), token: signed };
  });
}

// ─── Get Current Token ────────────────────────────────────────
export async function getCurrentToken(
  userId: string,
  deviceId: string,
  sessionPublicKey: string,
  kycTier: number = 0
): Promise<SignedToken | null> {
  if (config.isDemoMode) {
    const t = memStore.tokens.get(userId);
    if (!t) return null;
    if (new Date(t.expiresAt) < new Date()) return null;
    return t as SignedToken;
  }

  // Production path
  const { query } = require('../../db/postgres');
  const result = await query(
    `SELECT t.*, w.balance_paise FROM offline_tokens t
     JOIN wallets w ON w.user_id = t.user_id
     WHERE t.user_id = $1 AND t.revoked = FALSE AND t.expires_at > NOW()
     ORDER BY t.issued_at DESC LIMIT 1`,
    [userId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const payload = buildTokenPayload(userId, deviceId, sessionPublicKey,
    parseInt(row.balance_paise), parseInt(row.offline_limit_paise), parseInt(row.counter));
  return signToken(payload);
}

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}
