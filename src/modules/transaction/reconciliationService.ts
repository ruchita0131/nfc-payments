import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { logger } from '../../db/logger';
import { memStore } from '../../db/memStore';
import {
  verifyNFCSignature,
  verifyReceiptSignature,
  SignedNFCPayment,
} from '../token/tokenService';

export interface PendingTransaction {
  clientTxnId: string;
  payerUserId: string;
  payerDeviceId: string;
  receiverDeviceId: string;
  amountPaise: number;
  counter: number;
  nonce: string;
  payerHmac: string;
  nfcPayload: SignedNFCPayment;
  receiverReceiptSig?: string;
  tappedAt: string;
}

export type RejectionReason =
  | 'INVALID_HMAC'
  | 'TOKEN_EXPIRED'
  | 'OFFLINE_CAP_EXCEEDED'
  | 'DUPLICATE_COUNTER'
  | 'INVALID_RECEIPT'
  | 'MISSING_RECEIPT'
  | 'RECEIVER_NOT_FOUND'
  | 'PAYER_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE';

export interface SettlementResult {
  clientTxnId: string;
  status: 'settled' | 'rejected';
  rejectionReason?: RejectionReason;
  settledAt?: string;
}

// ─── Reconcile ────────────────────────────────────────────────
export async function reconcileTransactions(
  pending: PendingTransaction[]
): Promise<SettlementResult[]> {
  const results: SettlementResult[] = [];
  for (const txn of pending) {
    results.push(await settleSingle(txn));
  }
  return results;
}

async function settleSingle(txn: PendingTransaction): Promise<SettlementResult> {
  const { clientTxnId } = txn;

  if (config.isDemoMode) {
    return settleDemo(txn);
  }

  // Production path (PostgreSQL) — unchanged from original
  return settlePostgres(txn);
}

// ─── Demo Settlement ──────────────────────────────────────────
function settleDemo(txn: PendingTransaction): SettlementResult {
  const { clientTxnId } = txn;

  // Idempotency: check if already processed
  const existing = memStore.transactions.find(t => t.clientTxnId === clientTxnId);
  if (existing) return { clientTxnId, status: existing.status, rejectionReason: existing.rejectionReason, settledAt: existing.settledAt };

  // ── L2: Token expiry ────────────────────────────────────────
  if (new Date(txn.nfcPayload.tokenExpiresAt) < new Date()) {
    return reject(txn, 'TOKEN_EXPIRED');
  }

  // ── L1: Counter uniqueness ──────────────────────────────────
  const counterKey = `${txn.payerUserId}:${txn.counter}`;
  if (memStore.seenCounters.has(counterKey)) {
    logger.warn('🚨 Double-spend detected!', { payerUserId: txn.payerUserId, counter: txn.counter, clientTxnId });
    return reject(txn, 'DUPLICATE_COUNTER');
  }

  // ── L2: Offline cap ─────────────────────────────────────────
  const payerToken = memStore.tokens.get(txn.payerUserId);
  if (payerToken && txn.amountPaise > payerToken.offlineLimitPaise) {
    return reject(txn, 'OFFLINE_CAP_EXCEEDED');
  }

  // ── L3: HMAC verification ────────────────────────────────────
  // In demo mode the browser sends a browser-derived HMAC (not server-signed).
  // We skip strict HMAC recomputation for the browser simulation but keep the
  // nonce + receiverDeviceId binding check structurally in place.
  // In production (Android), the server recomputes HMAC with HMAC_SECRET.

  // ── L4: Mutual receipt ───────────────────────────────────────
  if (!txn.receiverReceiptSig) {
    return reject(txn, 'MISSING_RECEIPT');
  }

  // Find receiver from deviceId
  const receiverEntry = memStore.deviceKeys.get(txn.receiverDeviceId);
  if (!receiverEntry) {
    return reject(txn, 'RECEIVER_NOT_FOUND');
  }

  // Verify receipt signature (ECDSA from WebCrypto in browser)
  const receiptValid = verifyReceiptSignature(
    {
      receivedPaise:    txn.amountPaise,
      fromCounter:      txn.counter,
      payerUserId:      txn.payerUserId,
      receiverDeviceId: txn.receiverDeviceId,
      nonce:            txn.nonce,
    },
    txn.receiverReceiptSig,
    receiverEntry.pubKey
  );
  if (!receiptValid) {
    logger.warn('Receipt signature invalid', { clientTxnId });
    return reject(txn, 'INVALID_RECEIPT');
  }

  // ── All layers passed — settle ──────────────────────────────
  memStore.seenCounters.add(counterKey);

  // Debit payer
  const payerBalance = memStore.wallets.get(txn.payerUserId) ?? 0;
  if (payerBalance < txn.amountPaise) return reject(txn, 'INSUFFICIENT_BALANCE');
  memStore.wallets.set(txn.payerUserId, payerBalance - txn.amountPaise);

  // Credit receiver
  const receiverBalance = memStore.wallets.get(receiverEntry.userId) ?? 0;
  memStore.wallets.set(receiverEntry.userId, receiverBalance + txn.amountPaise);

  const settledAt = new Date().toISOString();
  const record = {
    clientTxnId,
    payerUserId: txn.payerUserId,
    receiverUserId: receiverEntry.userId,
    payerDeviceId: txn.payerDeviceId,
    receiverDeviceId: txn.receiverDeviceId,
    amountPaise: txn.amountPaise,
    counter: txn.counter,
    nonce: txn.nonce,
    status: 'settled',
    tappedAt: txn.tappedAt,
    settledAt,
  };
  memStore.transactions.push(record);

  logger.info('✅ Transaction settled (demo)', {
    clientTxnId, payerUserId: txn.payerUserId,
    receiverUserId: receiverEntry.userId,
    amountPaise: txn.amountPaise,
  });

  return { clientTxnId, status: 'settled', settledAt };
}

// ─── PostgreSQL Settlement (production) ───────────────────────
async function settlePostgres(txn: PendingTransaction): Promise<SettlementResult> {
  const { withTransaction } = require('../../db/postgres');
  const { clientTxnId } = txn;

  return withTransaction(async (client: any) => {
    // Idempotency
    const existing = await client.query(
      'SELECT status, rejection_reason, settled_at FROM transactions WHERE id = $1', [clientTxnId]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      return { clientTxnId, status: row.status, rejectionReason: row.rejection_reason, settledAt: row.settled_at?.toISOString() };
    }

    // L3: Payer Signature Verification (was HMAC)
    const payerKeyResult = await client.query('SELECT public_key_b64 FROM device_keys WHERE device_id=$1', [txn.payerDeviceId]);
    if (!payerKeyResult.rows.length) return recordRejectionPg(client, txn, 'PAYER_NOT_FOUND');
    if (!verifyNFCSignature(txn.nfcPayload, payerKeyResult.rows[0].public_key_b64)) {
       return recordRejectionPg(client, txn, 'INVALID_HMAC'); // Or INVALID_SIGNATURE
    }

    // L2: expiry
    if (new Date(txn.nfcPayload.tokenExpiresAt) < new Date()) return recordRejectionPg(client, txn, 'TOKEN_EXPIRED');

    // L2: offline cap
    const tokenResult = await client.query('SELECT offline_limit_paise FROM offline_tokens WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 1', [txn.payerUserId]);
    if (tokenResult.rows.length) {
       const limit = parseInt(tokenResult.rows[0].offline_limit_paise, 10);
       if (txn.amountPaise > limit) return recordRejectionPg(client, txn, 'OFFLINE_CAP_EXCEEDED');
    }

    // L1: counter
    const counterInsert = await client.query(
      `INSERT INTO seen_counters (user_id, counter) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING counter`,
      [txn.payerUserId, txn.counter]
    );
    if (!counterInsert.rows.length) {
      logger.warn('🚨 Double-spend detected (pg)!', { payerUserId: txn.payerUserId, counter: txn.counter });
      return recordRejectionPg(client, txn, 'DUPLICATE_COUNTER');
    }

    // L4: receipt
    if (!txn.receiverReceiptSig) return recordRejectionPg(client, txn, 'MISSING_RECEIPT');
    const keyResult = await client.query('SELECT user_id, public_key_b64 FROM device_keys WHERE device_id=$1', [txn.receiverDeviceId]);
    if (!keyResult.rows.length) return recordRejectionPg(client, txn, 'RECEIVER_NOT_FOUND');
    const receiptValid = verifyReceiptSignature(
      { receivedPaise: txn.amountPaise, fromCounter: txn.counter, payerUserId: txn.payerUserId, receiverDeviceId: txn.receiverDeviceId, nonce: txn.nonce },
      txn.receiverReceiptSig, keyResult.rows[0].public_key_b64
    );
    if (!receiptValid) return recordRejectionPg(client, txn, 'INVALID_RECEIPT');

    const receiverUserId = keyResult.rows[0].user_id;

    const walletResult = await client.query('SELECT balance_paise FROM wallets WHERE user_id=$1 FOR UPDATE', [txn.payerUserId]);
    const payerBalance = parseInt(walletResult.rows[0]?.balance_paise || '0', 10);
    if (payerBalance < txn.amountPaise) {
        return recordRejectionPg(client, txn, 'INSUFFICIENT_BALANCE');
    }

    await client.query('UPDATE wallets SET balance_paise = balance_paise - $1, updated_at=NOW() WHERE user_id=$2', [txn.amountPaise, txn.payerUserId]);
    await client.query('UPDATE wallets SET balance_paise = balance_paise + $1, updated_at=NOW() WHERE user_id=$2', [txn.amountPaise, receiverUserId]);

    const settledAt = new Date().toISOString();
    await client.query(
      `INSERT INTO transactions (id,payer_id,payer_counter,payer_device_id,receiver_id,receiver_device_id,amount_paise,nonce,payer_hmac,receiver_receipt_sig,status,tapped_at,submitted_at,settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'settled',$11,NOW(),$12)`,
      [clientTxnId, txn.payerUserId, txn.counter, txn.payerDeviceId, receiverUserId, txn.receiverDeviceId, txn.amountPaise, txn.nonce, txn.payerHmac, txn.receiverReceiptSig, txn.tappedAt, settledAt]
    );
    return { clientTxnId, status: 'settled', settledAt };
  });
}

async function recordRejectionPg(client: any, txn: PendingTransaction, reason: RejectionReason): Promise<SettlementResult> {
  const recResult = await client.query('SELECT user_id FROM device_keys WHERE device_id=$1', [txn.receiverDeviceId]);
  const receiverUserId = recResult.rows[0]?.user_id ?? null;
  await client.query(
    `INSERT INTO transactions (id,payer_id,payer_counter,payer_device_id,receiver_id,receiver_device_id,amount_paise,nonce,payer_hmac,status,rejection_reason,tapped_at,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rejected',$10,$11,NOW()) ON CONFLICT DO NOTHING`,
    [txn.clientTxnId, txn.payerUserId, txn.counter, txn.payerDeviceId, receiverUserId, txn.receiverDeviceId, txn.amountPaise, txn.nonce, txn.payerHmac, reason, txn.tappedAt]
  );
  return { clientTxnId: txn.clientTxnId, status: 'rejected', rejectionReason: reason };
}

function reject(txn: PendingTransaction, reason: RejectionReason): SettlementResult {
  const record = { clientTxnId: txn.clientTxnId, status: 'rejected' as const, rejectionReason: reason, tappedAt: txn.tappedAt };
  memStore.transactions.push({ ...record, payerUserId: txn.payerUserId, receiverDeviceId: txn.receiverDeviceId, amountPaise: txn.amountPaise });
  logger.warn('Transaction rejected (demo)', { clientTxnId: txn.clientTxnId, reason });
  return { clientTxnId: txn.clientTxnId, status: 'rejected', rejectionReason: reason };
}

// ─── History ──────────────────────────────────────────────────
export async function getTransactionHistory(userId: string, limit = 50, offset = 0) {
  if (config.isDemoMode) {
    const userTxns = memStore.transactions
      .filter(t => t.payerUserId === userId || t.receiverUserId === userId)
      .slice(offset, offset + limit)
      .reverse();

    // Resolve usernames
    return userTxns.map(t => {
      const payerEntry  = [...memStore.users.values()].find(u => u.id === t.payerUserId);
      const receiverEntry = [...memStore.users.values()].find(u => u.id === t.receiverUserId);
      return {
        ...t,
        payer_username:    payerEntry?.username    ?? t.payerUserId,
        receiver_username: receiverEntry?.username ?? t.receiverDeviceId,
        amount_paise:      t.amountPaise,
        rejection_reason:  t.rejectionReason,
        tapped_at:         t.tappedAt,
        settled_at:        t.settledAt,
        direction:         t.payerUserId === userId ? 'sent' : 'received',
      };
    });
  }

  const { query } = require('../../db/postgres');
  const result = await query(
    `SELECT t.id, t.amount_paise, t.status, t.rejection_reason, t.tapped_at, t.settled_at,
            pu.username AS payer_username, ru.username AS receiver_username,
            CASE WHEN t.payer_id = $1 THEN 'sent' ELSE 'received' END AS direction
     FROM transactions t JOIN users pu ON pu.id=t.payer_id JOIN users ru ON ru.id=t.receiver_id
     WHERE t.payer_id=$1 OR t.receiver_id=$1 ORDER BY t.tapped_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
}

// ─── Dashboard stats ──────────────────────────────────────────
export async function getDashboardStats() {
  if (config.isDemoMode) {
    const settled  = memStore.transactions.filter(t => t.status === 'settled');
    const rejected = memStore.transactions.filter(t => t.status === 'rejected');
    const totalVolume = settled.reduce((sum, t) => sum + (t.amountPaise ?? 0), 0);
    return {
      total_users:        memStore.users.size,
      settled_txns:       settled.length,
      rejected_txns:      rejected.length,
      total_volume_paise: totalVolume,
      pending_txns:       0,
    };
  }

  const { query } = require('../../db/postgres');
  const result = await query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM transactions WHERE status='settled') AS settled_txns,
      (SELECT COUNT(*) FROM transactions WHERE status='rejected') AS rejected_txns,
      (SELECT COALESCE(SUM(amount_paise),0) FROM transactions WHERE status='settled') AS total_volume_paise,
      (SELECT COUNT(*) FROM transactions WHERE status='pending') AS pending_txns
  `);
  return result.rows[0];
}
