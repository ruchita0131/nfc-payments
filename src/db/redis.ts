import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

let redisClient: Redis;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    redisClient.on('connect', () => logger.info('Redis connected'));
    redisClient.on('error', (err) => logger.error('Redis error', { error: err.message }));
  }
  return redisClient;
}

/**
 * Store a nonce with a short TTL (120 seconds — longer than any NFC tap should take).
 * Bob generates the nonce; we cache it server-side so we can verify it wasn't recycled
 * during reconciliation.
 */
export async function cacheNonce(nonce: string, receiverDeviceId: string): Promise<void> {
  await getRedis().set(`nonce:${nonce}`, receiverDeviceId, 'EX', 120);
}

/**
 * Consume a nonce — returns the receiverDeviceId it was issued for, or null if expired/invalid.
 * Atomic GET+DEL prevents race conditions.
 */
export async function consumeNonce(nonce: string): Promise<string | null> {
  const multi = getRedis().multi();
  multi.get(`nonce:${nonce}`);
  multi.del(`nonce:${nonce}`);
  const results = await multi.exec();
  if (!results) return null;
  return results[0][1] as string | null;
}

export async function testConnection(): Promise<void> {
  await getRedis().ping();
  logger.info('Redis ping OK');
}
