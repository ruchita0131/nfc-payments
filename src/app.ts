import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { config } from './config';
import { logger } from './db/logger';
import routes from './routes';
import { errorHandler } from './middleware/errorHandler';

async function bootstrap() {
  // ── DB connections ───────────────────────────────────────────
  if (!config.isDemoMode) {
    const { testConnection: pgTest } = await import('./db/postgres');
    await pgTest();
    // Redis is optional — used for nonce caching only
    if (config.redisUrl) {
      try {
        const { testConnection: redisTest } = await import('./db/redis');
        await redisTest();
      } catch {
        logger.warn('Redis unavailable — nonce caching disabled. Install Redis for production use.');
      }
    }
  } else {
    await import('./db/memStore');
  }

  const app = express();

  // ── Security headers ─────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc:    ["'self'"],
          scriptSrc:     ["'self'", "'unsafe-inline'"],
          scriptSrcAttr: ["'unsafe-inline'"],   // allows onclick= handlers in HTML
          styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc:       ["'self'", 'https://fonts.gstatic.com'],
          imgSrc:        ["'self'", 'data:'],
          connectSrc:    ["'self'"],
        },
      },
    })
  );

  app.use(cors({ origin: config.nodeEnv === 'development' ? '*' : undefined }));
  app.use(express.json({ limit: '1mb' }));

  // ── Rate limiting ─────────────────────────────────────────────
  app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { success: false, error: 'Too many requests' } }));

  // ── API routes ────────────────────────────────────────────────
  app.use('/api', routes);

  // ── Web dashboard (static) ────────────────────────────────────
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // ── Error handler ─────────────────────────────────────────────
  app.use(errorHandler);

  app.listen(config.port, () => {
    logger.info(`🚀 NFC Payments running → http://localhost:${config.port}`, {
      mode:              config.isDemoMode ? 'DEMO (in-memory)' : 'PRODUCTION (PostgreSQL)',
      tokenTtlHours:     config.tokenTtlHours,
    });
    if (config.isDemoMode) {
      logger.info('💡 Demo mode: register users, load wallets, simulate NFC taps — no DB needed.');
    }
  });
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err.message);
  console.error('Stack:', err.stack);
  process.exit(1);
});
