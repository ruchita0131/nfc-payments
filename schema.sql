-- ============================================================
-- NFC Payments — PostgreSQL Schema
-- ============================================================

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────────────────────
-- USERS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(64) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  kyc_tier      SMALLINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- DEVICE KEYS
-- Each user can register one device. Stores the session
-- public key (for receipt signature verification).
-- Production: rotate on every token issuance.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       VARCHAR(128) UNIQUE NOT NULL,
  -- Base64-encoded ECDSA public key (device-generated, Android Keystore)
  -- Used to verify mutual receipts offline.
  -- Production upgrade: require StrongBox attestation certificate here.
  public_key_b64  TEXT NOT NULL,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id);

-- ────────────────────────────────────────────────────────────
-- WALLETS
-- Server-side balance (source of truth after reconciliation)
-- Amounts in paise (₹1 = 100 paise) — avoids float arithmetic
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Balance in paise. ₹500 = 50000
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- OFFLINE TOKENS
-- Each token represents an authorised offline spending budget.
-- A new token is issued on every /wallet/load or /wallet/sync.
-- Previous tokens are revoked on issuance.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offline_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Snapshot of server balance at issuance (paise)
  issued_balance_paise BIGINT NOT NULL,
  -- Hardcoded offline cap at issuance (paise). Default: ₹200 = 20000
  offline_limit_paise  BIGINT NOT NULL DEFAULT 20000,
  -- Monotonically increasing counter. Backend rejects any counter ≤ last_seen.
  -- This is the primary spending counter used for double-spend detection.
  counter             BIGINT NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ NOT NULL,
  -- Base64-encoded HMAC-SHA256 of the token payload
  hmac                TEXT NOT NULL,
  revoked             BOOLEAN NOT NULL DEFAULT FALSE,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON offline_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON offline_tokens(expires_at);

-- ────────────────────────────────────────────────────────────
-- SEEN COUNTERS (Layer 1 Double-Spend Guard)
-- Each (user_id, counter) pair can only settle once.
-- INSERT ... ON CONFLICT DO NOTHING is the atomic guard.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seen_counters (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counter  BIGINT NOT NULL,
  seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, counter)
);

-- ────────────────────────────────────────────────────────────
-- PENDING TRANSACTIONS
-- Created by the Android sync worker on reconnect.
-- Status: pending → settled | rejected
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Payer (Alice)
  payer_id             UUID NOT NULL REFERENCES users(id),
  payer_counter        BIGINT NOT NULL,
  payer_device_id      VARCHAR(128) NOT NULL,
  -- Receiver (Bob)
  receiver_id          UUID NOT NULL REFERENCES users(id),
  receiver_device_id   VARCHAR(128) NOT NULL,
  -- Payment details (paise)
  amount_paise         BIGINT NOT NULL CHECK (amount_paise > 0),
  -- Nonce challenge sent by Bob → bound to this specific tap
  nonce                VARCHAR(64) NOT NULL,
  -- HMAC over {userId, amount, counter, nonce, receiverDeviceId, expiresAt}
  -- Recomputed server-side on sync to verify authenticity
  payer_hmac           TEXT NOT NULL,
  -- Bob's ECDSA receipt signature over {received, fromCounter, aliceId}
  -- Verified against Bob's registered public key
  receiver_receipt_sig TEXT,
  -- Settlement
  status               VARCHAR(16) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'settled', 'rejected')),
  rejection_reason     TEXT,
  tapped_at            TIMESTAMPTZ NOT NULL,   -- device clock at NFC tap
  submitted_at         TIMESTAMPTZ,            -- when synced to backend
  settled_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txn_payer ON transactions(payer_id);
CREATE INDEX IF NOT EXISTS idx_txn_receiver ON transactions(receiver_id);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_txn_nonce ON transactions(nonce);

-- ────────────────────────────────────────────────────────────
-- AUDIT LOG
-- Immutable append-only log of all security-relevant events.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  user_id    UUID REFERENCES users(id),
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
