/**
 * In-memory store for demo mode (no PostgreSQL/Redis required).
 * Data resets on server restart. Switch to real DB by setting DATABASE_URL.
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from './logger';

// ── Data stores ───────────────────────────────────────────────
const users: Map<string, { id: string; username: string; passwordHash: string; kycTier: number }> = new Map();
const wallets: Map<string, number> = new Map();           // userId → paise
const deviceKeys: Map<string, { userId: string; pubKey: string }> = new Map(); // deviceId → {...}
const tokens: Map<string, any> = new Map();               // userId → latest token
const seenCounters: Set<string> = new Set();              // "userId:counter"
const transactions: any[] = [];

export const memStore = { users, wallets, deviceKeys, tokens, seenCounters, transactions };

// ── Fake "query" surface that mirrors pg QueryResult ──────────
export function memQuery(
  sql: string,
  params: any[] = []
): { rows: any[]; rowCount: number } {
  // Not used directly — memStore is accessed by service overrides below
  return { rows: [], rowCount: 0 };
}

logger.info('🗃️  Running in DEMO mode (in-memory store). No PostgreSQL/Redis required.');
logger.info('   Data resets on restart. Set DATABASE_URL to use real PostgreSQL.');
