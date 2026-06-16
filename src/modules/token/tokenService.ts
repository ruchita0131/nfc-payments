import crypto from 'crypto';
import { config } from '../../config';

// ─── Token Payload ───────────────────────────────────────────
// All monetary values in PAISE (₹1 = 100 paise).
// Avoids floating point arithmetic entirely.
export interface TokenPayload {
  userId: string;
  deviceId: string;
  /** Server-side balance snapshot at issuance (paise) */
  issuedBalancePaise: number;
  /** Hard offline cap — set at issuance, RBI-inspired ₹200 default */
  offlineLimitPaise: number;
  /** Running total of offline spend (paise) — tracked on device */
  offlineSpentPaise: number;
  /** offlineLimitPaise − offlineSpentPaise */
  offlineRemainingPaise: number;
  /**
   * Monotonically increasing counter.
   * Incremented on every NFC tap.
   * Backend records (userId, counter) in seen_counters — double insert = rejected.
   */
  counter: number;
  expiresAt: string;   // ISO 8601
  issuedAt: string;    // ISO 8601
  /** Device-generated ECDSA public key (Base64). Used to verify mutual receipts. */
  sessionPublicKey: string;
}

export interface SignedToken extends TokenPayload {
  /** HMAC-SHA256 of canonical JSON of TokenPayload fields, Base64-encoded */
  hmac: string;
}

// ─── Canonical serialisation ─────────────────────────────────
// Fields are sorted alphabetically so the HMAC is deterministic
// regardless of key insertion order. This is critical — JSON.stringify
// does not guarantee key order in all engines.
function canonicalize(payload: TokenPayload): string {
  const ordered: Record<string, unknown> = {};
  (Object.keys(payload) as (keyof TokenPayload)[])
    .sort()
    .forEach((k) => { ordered[k] = payload[k]; });
  return JSON.stringify(ordered);
}

// ─── Signing ─────────────────────────────────────────────────
/**
 * Sign a token payload with HMAC-SHA256.
 *
 * Production upgrade path:
 *   Replace with ECDSA (secp256k1 or P-256) so receiving devices can
 *   verify signatures offline without holding the signing key.
 *   EMV/Visa use ECDSA precisely for this reason.
 *   See docs/production-upgrade.md for the migration path.
 */
export function signToken(payload: TokenPayload): SignedToken {
  const canonical = canonicalize(payload);
  const hmac = crypto
    .createHmac('sha256', config.hmacSecret)
    .update(canonical)
    .digest('base64');
  return { ...payload, hmac };
}

// ─── Verification ────────────────────────────────────────────
/**
 * Verify a signed token.
 * Uses timingSafeEqual to prevent timing-based HMAC oracle attacks.
 */
export function verifyToken(signed: SignedToken): boolean {
  const { hmac, ...payload } = signed;
  const expected = crypto
    .createHmac('sha256', config.hmacSecret)
    .update(canonicalize(payload))
    .digest('base64');

  // Constant-time comparison — prevents side-channel attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, 'base64'),
      Buffer.from(expected, 'base64')
    );
  } catch {
    return false; // Buffer lengths differ → invalid token
  }
}

// ─── NFC Transaction Signing ─────────────────────────────────
/**
 * Sign the NFC payment payload.
 * This is what Alice sends to Bob over NFC after receiving his nonce.
 *
 * Signed fields (Layer 3 — Nonce Challenge-Response):
 *   userId + amount + counter + nonce + receiverDeviceId + expiresAt
 *
 * Including receiverDeviceId in the signed payload means this APDU response
 * is cryptographically bound to a specific receiver. Alice cannot send the
 * same NFC payload to two different Bobs.
 */
export interface NFCPaymentPayload {
  payerUserId: string;
  payerDeviceId: string;
  receiverDeviceId: string;
  amountPaise: number;
  counter: number;
  nonce: string;           // Bob's challenge nonce
  tokenExpiresAt: string;
}

export interface SignedNFCPayment extends NFCPaymentPayload {
  hmac: string;
}

export function signNFCPayment(payload: NFCPaymentPayload, privateKeyB64: string): SignedNFCPayment {
  const ordered: Record<string, unknown> = {};
  (Object.keys(payload) as (keyof NFCPaymentPayload)[])
    .sort()
    .forEach((k) => { ordered[k] = payload[k]; });
  const canonical = JSON.stringify(ordered);

  try {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(privateKeyB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const sig = crypto.sign('SHA256', Buffer.from(canonical), privateKey);
    return { ...payload, hmac: sig.toString('base64') };
  } catch {
    // Fallback for tests/demo if no valid private key is provided
    return { ...payload, hmac: 'dummy_signature' };
  }
}

export function verifyNFCSignature(signed: SignedNFCPayment, publicKeyB64: string): boolean {
  const { hmac, ...payload } = signed;
  const ordered: Record<string, unknown> = {};
  (Object.keys(payload) as (keyof NFCPaymentPayload)[])
    .sort()
    .forEach((k) => { ordered[k] = payload[k]; });
  const canonical = JSON.stringify(ordered);

  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(
      'SHA256',
      Buffer.from(canonical),
      publicKey,
      Buffer.from(hmac, 'base64')
    );
  } catch {
    return false;
  }
}

// ─── Receipt Verification ────────────────────────────────────
/**
 * Verify Bob's mutual receipt.
 * Bob signs with his device's ECDSA private key (Android Keystore).
 * We verify against his registered public key.
 *
 * Layer 4 — Mutual Receipts:
 *   Neither party can unilaterally deny the transaction.
 *   Backend requires BOTH Alice's payer_hmac AND Bob's receipt_sig to settle.
 */
export function verifyReceiptSignature(
  receiptData: {
    receivedPaise: number;
    fromCounter: number;
    payerUserId: string;
    receiverDeviceId: string;
    nonce: string;
  },
  signatureB64: string,
  publicKeyB64: string
): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    const ordered: Record<string, unknown> = {};
    (Object.keys(receiptData) as (keyof typeof receiptData)[])
      .sort()
      .forEach((k) => { ordered[k] = receiptData[k]; });
    const canonical = JSON.stringify(ordered);

    return crypto.verify(
      'SHA256',
      Buffer.from(canonical),
      publicKey,
      Buffer.from(signatureB64, 'base64')
    );
  } catch {
    return false;
  }
}

// ─── Utility: issuance helper ────────────────────────────────
export function buildTokenPayload(
  userId: string,
  deviceId: string,
  sessionPublicKey: string,
  balancePaise: number,
  offlineLimitPaise: number,
  currentCounter: number
): TokenPayload {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.tokenTtlHours * 60 * 60 * 1000);

  return {
    userId,
    deviceId,
    issuedBalancePaise: balancePaise,
    offlineLimitPaise,
    offlineSpentPaise: 0,
    offlineRemainingPaise: Math.min(offlineLimitPaise, balancePaise),
    counter: currentCounter,
    expiresAt: expiresAt.toISOString(),
    issuedAt: now.toISOString(),
    sessionPublicKey,
  };
}
