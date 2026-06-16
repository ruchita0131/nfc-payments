# Offline NFC Payments

A secure, offline-first NFC payment system built as a full-stack portfolio project demonstrating cryptographic double-spend prevention, tiered KYC limits, and offline phone-to-phone NFC tap payments.

## App Screenshots

### Android App (Native Kotlin)
<p align="center">
  <img src="docs/screenshots/android_01_login.png" width="23%" />
  <img src="docs/screenshots/android_02_wallet.png" width="23%" />
  <img src="docs/screenshots/android_03_tap.png" width="23%" />
  <img src="docs/screenshots/android_04_success.png" width="23%" />
</p>

### Web Dashboard
<details>
<summary>Click to view Web Dashboard Screenshots</summary>
<br>

**1. Dashboard & KYC Registration**
<p align="center">
  <img src="docs/screenshots/web_03_dashboard.png" width="48%" />
  <img src="docs/screenshots/web_02_register_kyc.png" width="48%" />
</p>

**2. Wallet & NFC Simulator**
<p align="center">
  <img src="docs/screenshots/web_05_wallet_loaded.png" width="48%" />
  <img src="docs/screenshots/web_06_tap.png" width="48%" />
</p>

**3. Offline Transaction Sync**
<p align="center">
  <img src="docs/screenshots/web_07_tap_result.png" width="48%" />
  <img src="docs/screenshots/web_08_transactions.png" width="48%" />
</p>
</details>

---

## System Architecture

```
┌──────────────────────────────────────────────────────┐
│                 Android App (Payer)                  │
│  KYC Tier selection → ECDSA Keystore key generation  │
│  Wallet loading → HMAC-signed offline token          │
│  TapFragment → PaymentHCEService (ISO 14443-4 HCE)   │
└─────────────────────┬────────────────────────────────┘
                      │  NFC (APDU over ISO 14443-4)
┌─────────────────────▼────────────────────────────────┐
│                 Android App (Receiver)               │
│  NFCReaderManager → Nonce challenge/response         │
│  Mutual ECDSA receipt signing (Layer 4)              │
│  SyncWorker → POST /transactions/sync on reconnect   │
└─────────────────────┬────────────────────────────────┘
                      │  HTTPS (Retrofit)
┌─────────────────────▼────────────────────────────────┐
│            Node.js + Express Backend                 │
│  POST /auth/register  → kycTier → JWT                │
│  POST /wallet/load    → HMAC-signed token issued     │
│  POST /transactions/sync → 4-layer reconciliation   │
└─────────────────────┬────────────────────────────────┘
                      │
              PostgreSQL 17 (or in-memory demo mode)
```

---

## 4-Layer Double-Spend Prevention

| Layer | Mechanism | What it catches |
|-------|-----------|-----------------|
| **L1** | Monotonic counter (server-side) | Replaying the same counter twice |
| **L2** | KYC-tiered offline cap + 24h token TTL | Bounds worst-case exposure window |
| **L3** | Nonce challenge-response | Replay attacks (same payload, different receiver) |
| **L4** | Mutual ECDSA receipt (Android Keystore) | Disputes (cryptographic proof of intent) |

> **Design Choice:** The offline limit acts as a risk dial. Higher KYC verification unlocks higher offline spending limits. The nonce binding and mutual receipt system ensures any double-spend attempt is cryptographically traceable to the payer, justifying a dynamic limit rather than a static regulatory ceiling.

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 17 (+ in-memory demo mode) |
| Auth | JWT, bcrypt, HMAC-SHA256 |
| Android | Kotlin, Jetpack Navigation, Retrofit, Room, WorkManager |
| NFC Protocol | HCE (Host Card Emulation), ISO 14443-4, APDU |
| Crypto | ECDSA (Android Keystore), HMAC-SHA256 |

---

## KYC-Tiered Offline Limits

The offline spending limit scales dynamically based on identity verification:

| Tier | Verification | Offline Limit |
|------|-------------|---------------|
| 0 | Phone number only | ₹500 |
| 1 | Aadhaar linked | ₹2,000 |
| 2 | Full KYC + bank account | ₹5,000 |

The limit is embedded inside the HMAC-signed token at issuance, preventing local tampering.

---

## Running Locally

### Prerequisites
- Node.js 18+
- PostgreSQL 17 (optional — app runs in demo mode without it)
- Android Studio (for the mobile app)

### 1. Backend

```bash
cd nfc-payments
npm install
cp .env.example .env   # Edit with your PostgreSQL credentials
npm run dev
```

The server starts at **http://localhost:3000**

**Demo mode** (no PostgreSQL needed): set `DEMO_MODE=true` in `.env`

### 2. Web Dashboard

Open **http://localhost:3000** in any browser.

- Register with a KYC Tier (0/1/2) to set your offline spending limit
- Load your wallet
- Simulate an NFC tap between Alice and Bob

### 3. Android App

1. Open the `android/` folder in Android Studio
2. Find your PC's local IP: run `ipconfig` in PowerShell → look for **IPv4 Address**
3. In `android/app/src/main/java/com/nfcpay/network/RetrofitClient.kt`, update:
   ```kotlin
   private const val BASE_URL = "http://YOUR_IP:3000/api/"
   ```
4. Connect two Android phones (NFC-capable, Android 8.0+) to your PC
5. Both phones must be on the **same Wi-Fi network** as your PC
6. Click **Run ▶** in Android Studio to install on both

### 4. Physical NFC Tap Test

**Phone 1 (Payer):**
- Register → select KYC Tier 2 → Confirm Registration
- Wallet tab → Load ₹1000
- Tap to Pay tab → stay on **Pay (HCE)** mode

**Phone 2 (Receiver):**
- Register → any tier
- Tap to Pay tab → switch to **Receive (Reader)**
- Enter amount (e.g. `50`) → tap **Start NFC Reader**

**Tap the back of Phone 1 against Phone 2.** The 3-message APDU protocol runs, mutual receipts are exchanged, and the transaction is queued for backend sync.

---

## Project Structure

```
nfc-payments/
├── src/                          # Node.js backend (TypeScript)
│   ├── modules/
│   │   ├── auth/                 # Registration, login, JWT, KYC tier
│   │   ├── wallet/               # Balance, token issuance
│   │   ├── token/                # HMAC-signed offline token builder
│   │   └── transaction/          # Reconciliation (4-layer double-spend)
│   ├── db/
│   │   ├── postgres.ts           # PostgreSQL pool
│   │   └── memStore.ts           # In-memory demo store
│   └── config/index.ts
├── public/                       # Web dashboard (vanilla HTML/JS)
│   ├── index.html
│   └── app.js
├── android/                      # Kotlin Android app
│   └── app/src/main/java/com/nfcpay/
│       ├── hce/                  # PaymentHCEService (payer side)
│       ├── nfc/                  # NFCReaderManager (receiver side)
│       ├── crypto/               # HMACHelper, ECDSA signing
│       ├── db/                   # Room database (pending transactions)
│       ├── network/              # Retrofit API layer
│       ├── sync/                 # SyncWorker (background reconciliation)
│       └── ui/                   # Login, Wallet, Tap fragments
├── schema.sql                    # PostgreSQL schema
└── .env.example                  # Environment variable template
```

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

```env
PORT=3000
NODE_ENV=development

# Set true to skip PostgreSQL (in-memory demo)
DEMO_MODE=false

HMAC_SECRET=your_32_char_secret_here_minimum!!
JWT_SECRET=another_strong_secret_for_jwt

# PostgreSQL connection
DATABASE_URL=postgresql://postgres:password@localhost:5432/nfc_payments

# Token TTL
TOKEN_TTL_HOURS=24
```

---

## Security Considerations

- **HMAC-SHA256:** Symmetric signature used for token issuance. Only the server can issue valid tokens. The client trusts the token received from the last authenticated online session.
- **ECDSA (Android Keystore):** Asymmetric signatures for mutual receipts. The private key never leaves secure hardware. Allows offline payment verification by the receiver.
- **Hardware Isolation:** Replace `KeyGenParameterSpec` with `.setIsStrongBoxBacked(true)` to enforce hardware-isolated keys on compatible devices.
- **Nonce Binding:** Cryptographically ties every NFC payload to a specific receiver, preventing replay attacks.

---

## Author

**Ruchita** — [github.com/ruchita0131](https://github.com/ruchita0131)
