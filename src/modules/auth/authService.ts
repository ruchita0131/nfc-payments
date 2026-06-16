import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config';
import { logger } from '../../db/logger';
import { memStore } from '../../db/memStore';

// Only import pg when real DB is configured
let pgQuery: typeof import('../../db/postgres').query | null = null;
if (!config.isDemoMode) {
  pgQuery = require('../../db/postgres').query;
}

const SALT_ROUNDS = 10; // reduced for demo speed

export interface RegisterInput {
  username: string;
  password: string;
  deviceId: string;
  publicKeyB64: string;
  kycTier?: number;
}

export interface LoginInput {
  username: string;
  password: string;
  deviceId: string;
}

export interface AuthResult {
  token: string;
  userId: string;
  username: string;
  kycTier: number;
}

// ─── Register ─────────────────────────────────────────────────
export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const { username, password, deviceId, publicKeyB64, kycTier = 0 } = input;

  if (config.isDemoMode) {
    // ── Demo: in-memory ──────────────────────────────────────
    if (memStore.users.has(username)) {
      throw Object.assign(new Error('Username already taken'), { statusCode: 409 });
    }
    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    memStore.users.set(username, { id: userId, username, passwordHash, kycTier });
    memStore.wallets.set(userId, 0);
    memStore.deviceKeys.set(deviceId, { userId, pubKey: publicKeyB64 });
    logger.info('User registered (demo)', { userId, username, kycTier });
    return { token: issueJWT(userId, username, kycTier), userId, username, kycTier };
  }

  // ── Production: PostgreSQL ──────────────────────────────────
  const { withTransaction } = require('../../db/postgres');
  return withTransaction(async (client: any) => {
    const existing = await client.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rowCount > 0) throw Object.assign(new Error('Username already taken'), { statusCode: 409 });
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = uuidv4();
    await client.query('INSERT INTO users (id, username, password_hash, kyc_tier) VALUES ($1,$2,$3,$4)', [userId, username, passwordHash, kycTier]);
    await client.query('INSERT INTO wallets (user_id, balance_paise) VALUES ($1,0)', [userId]);
    await client.query(
      `INSERT INTO device_keys (user_id, device_id, public_key_b64) VALUES ($1,$2,$3) ON CONFLICT (device_id) DO UPDATE SET public_key_b64=EXCLUDED.public_key_b64`,
      [userId, deviceId, publicKeyB64]
    );
    logger.info('User registered (db)', { userId, username, kycTier });
    return { token: issueJWT(userId, username, kycTier), userId, username, kycTier };
  });
}

// ─── Login ────────────────────────────────────────────────────
export async function loginUser(input: LoginInput): Promise<AuthResult> {
  const { username, password } = input;

  if (config.isDemoMode) {
    const user = memStore.users.get(username);
    if (!user) {
      await bcrypt.hash('dummy', SALT_ROUNDS);
      throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
    logger.info('User logged in (demo)', { username });
    return { token: issueJWT(user.id, user.username, user.kycTier), userId: user.id, username: user.username, kycTier: user.kycTier };
  }

  // Production path
  const result = await pgQuery!<{ id: string; username: string; password_hash: string; kyc_tier: number }>(
    'SELECT id, username, password_hash, kyc_tier FROM users WHERE username = $1', [username]
  );
  if (!result.rows.length) {
    await bcrypt.hash('dummy', SALT_ROUNDS);
    throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  }
  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  return { token: issueJWT(user.id, user.username, user.kyc_tier), userId: user.id, username: user.username, kycTier: user.kyc_tier };
}

// ─── JWT ──────────────────────────────────────────────────────
function issueJWT(userId: string, username: string, kycTier: number): string {
  return jwt.sign({ sub: userId, username, kycTier }, config.jwtSecret, { expiresIn: config.jwtExpiresIn as any });
}

export function verifyJWT(token: string): { sub: string; username: string; kycTier: number } {
  return jwt.verify(token, config.jwtSecret) as { sub: string; username: string; kycTier: number };
}
