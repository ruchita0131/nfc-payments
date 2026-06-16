# 🔐 Offline NFC Payments

A secure, offline-first NFC payment system built as a full-stack portfolio project — demonstrating cryptographic double-spend prevention, tiered KYC limits, and real phone-to-phone NFC tap payments.

---

## 🏗️ Architecture

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

## 🔒 4-Layer Double-Spend Prevention

| Layer | Mechanism | What it catches |
|-------|-----------|-----------------|
| **L1** | Monotonic counter (server-side) | Alice replaying the same counter twice |
| **L2** | KYC-tiered offline cap + 24h token TTL | Bounds worst-case exposure window |
| **L3** | Nonce challenge-response | Replay attacks — same payload, different receiver |
| **L4** | Mutual ECDSA receipt (Android Keystore) | Disputes — cryptographic proof of intent |

> **Interview answer:** *"The ₹200 limit is RBI's regulatory choice for e-Rupee, not a technical constraint. My system uses a tiered limit based on KYC level — higher verification unlocks higher offline spending. The nonce binding and mutual receipt system means any double-spend attempt is cryptographically traceable to the payer, which justifies a higher limit than anonymous token systems. The limit is a risk dial, not a ceiling."*

---

## 🧰 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 17 (+ in-memory demo mode) |
| Auth | JWT, bcrypt, HMAC-SHA256 |
| Android | Kotlin, Jetpack Navigation, Retrofit, Room, WorkManager |
| NFC Protocol | HCE (Host Card Emulation), ISO 14443-4, APDU |
| Crypto | ECDSA (Android Keystore), HMAC-SHA256 |

---

## 💳 KYC-Tiered Offline Limits

The offline spending limit is not hardcoded — it's a **risk dial** tied to identity verification:

| Tier | Verification | Offline Limit |
|------|-------------|---------------|
| 0 | Phone number only | ₹500 |
| 1 | Aadhaar linked | ₹2,000 |
| 2 | Full KYC + bank account | ₹5,000 |

The limit is embedded inside the HMAC-signed token at issuance — **the phone cannot modify it**.

---

## 🚀 Running Locally

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

**Tap the back of Phone 1 against Phone 2** — the 3-message APDU protocol runs, mutual receipts are exchanged, and the transaction is queued for backend sync.

---

## 📁 Project Structure

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

## 🔑 Environment Variables

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

## 🛡️ Security Notes

- **HMAC-SHA256** is symmetric — only the server can issue valid tokens. The device trusts the token received from its last online session.
- **ECDSA (Android Keystore)** is asymmetric — the private key never leaves the secure hardware. In production, receiving phones could verify payments offline without the signing key, exactly like EMV chip cards.
- **StrongBox upgrade path:** Replace `KeyGenParameterSpec` with `.setIsStrongBoxBacked(true)` for hardware-isolated keys on supported devices.
- **Nonce binding** ensures every NFC payload is cryptographically tied to a specific receiver — you cannot replay the same tap payload to a different person.

---

## 👩‍💻 Author

**Ruchita** — [github.com/ruchita0131](https://github.com/ruchita0131)
