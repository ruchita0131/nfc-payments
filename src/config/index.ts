import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// HMAC_SECRET is the only hard requirement — enforce length
const hmacSecret = process.env.HMAC_SECRET || 'demo_secret_for_local_dev_only_32x';
if (hmacSecret.length < 32) {
  throw new Error(
    `HMAC_SECRET must be ≥ 32 characters (got ${hmacSecret.length}).`
  );
}

// Demo mode: set DEMO_MODE=true OR leave DATABASE_URL unset/empty
const isDemoMode = process.env.DEMO_MODE === 'true' || !process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDemoMode,

  // Security
  hmacSecret,
  jwtSecret: process.env.JWT_SECRET || 'demo_jwt_secret_local_dev_only_xyz',
  jwtExpiresIn: '7d',

  // Database (optional — falls back to in-memory)
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',

  // Token policy (RBI e-Rupee inspired)
  tokenTtlHours: parseInt(process.env.TOKEN_TTL_HOURS || '24', 10),
};

export type Config = typeof config;
