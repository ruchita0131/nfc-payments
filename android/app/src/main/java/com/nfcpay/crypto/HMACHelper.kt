package com.nfcpay.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.nfcpay.db.TokenPayload
import org.json.JSONObject
import java.security.*
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Cryptographic helpers for NFC Pay.
 *
 * ── HMAC-SHA256 ──────────────────────────────────────────────────────────────
 * Used to verify the offline token signed by the backend.
 * Symmetric — only the server (which holds HMAC_SECRET) can issue tokens.
 *
 * ── ECDSA (Android Keystore) ─────────────────────────────────────────────────
 * Used for mutual receipt signing (Layer 4 double-spend prevention).
 * The private key never leaves the Android Keystore.
 *
 * Production upgrade (StrongBox):
 *   Replace KeyGenParameterSpec builder with:
 *       .setIsStrongBoxBacked(true)
 *       .setMaxUsageCount(n)  // hardware-enforced usage limit
 *   StrongBox isolates the key in a dedicated secure element, making key
 *   extraction physically infeasible even with root access.
 *   Skipped here due to manufacturer fragmentation — not all devices (including
 *   budget Snapdragon devices) support StrongBox consistently.
 *
 * Interview note on ECDSA vs HMAC:
 *   HMAC is symmetric — you need the secret to both sign AND verify.
 *   This means only the server can verify transactions offline.
 *   ECDSA is asymmetric — you can distribute the public key freely.
 *   In production, receiving phones could verify Alice's payment offline
 *   without holding her signing key — exactly how EMV (chip-and-PIN) works.
 */
object HMACHelper {

    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val ALIAS_PREFIX      = "nfcpay_receipt_key_"

    // ── HMAC-SHA256 token verification ───────────────────────────────────────
    /**
     * Verify a backend-issued token. The server signs using HMAC_SECRET.
     * On mobile we can only verify if we cache the HMAC result from the
     * last /wallet/token API call — this is intentional:
     *   the device trusts the token it received from its last online session.
     * Double-spend checking happens server-side on reconciliation.
     *
     * Production alternative: ECDSA — receiver phone verifies without server.
     */
    fun verifyLocalToken(storedHmac: String, payload: TokenPayload, hmacKey: ByteArray): Boolean {
        val canonical = buildCanonicalJson(payload)
        val computed  = hmacSha256(canonical, hmacKey)
        // Constant-time comparison
        return MessageDigest.isEqual(
            Base64.getDecoder().decode(storedHmac),
            Base64.getDecoder().decode(computed)
        )
    }

    fun hmacSha256(data: String, key: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return Base64.getEncoder().encodeToString(mac.doFinal(data.toByteArray()))
    }

    // ── Canonical JSON serialisation ──────────────────────────────────────────
    // Fields sorted alphabetically — deterministic regardless of insertion order.
    private fun buildCanonicalJson(payload: TokenPayload): String {
        val obj = JSONObject().apply {
            put("counter",               payload.counter)
            put("deviceId",              payload.deviceId)
            put("expiresAt",             payload.expiresAt)
            put("issuedAt",              payload.issuedAt)
            put("issuedBalancePaise",    payload.issuedBalancePaise)
            put("offlineLimitPaise",     payload.offlineLimitPaise)
            put("offlineRemainingPaise", payload.offlineRemainingPaise)
            put("offlineSpentPaise",     payload.offlineSpentPaise)
            put("sessionPublicKey",      payload.sessionPublicKey)
            put("userId",               payload.userId)
        }
        // Sort keys for deterministic canonical form
        val sorted = JSONObject()
        obj.keys().asSequence().sorted().forEach { key -> sorted.put(key, obj.get(key)) }
        return sorted.toString()
    }

    // ── ECDSA keypair (Android Keystore) ──────────────────────────────────────
    fun generateOrGetReceiptKeyPair(userId: String): KeyPair {
        val alias = ALIAS_PREFIX + userId
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

        if (keyStore.containsAlias(alias)) {
            val entry = keyStore.getEntry(alias, null) as KeyStore.PrivateKeyEntry
            return KeyPair(entry.certificate.publicKey, entry.privateKey)
        }

        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            /*
             * Production upgrade: uncomment and target StrongBox:
             * .setIsStrongBoxBacked(true)
             * .setMaxUsageCount(1000)
             * This makes the key hardware-bound. Even with root access,
             * the private key cannot be extracted from the secure element.
             */
            .build()

        val kg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)
        kg.initialize(spec)
        return kg.generateKeyPair()
    }

    fun getPublicKeyB64(userId: String): String {
        val keyPair = generateOrGetReceiptKeyPair(userId)
        return Base64.getEncoder().encodeToString(keyPair.public.encoded)
    }

    // ── Sign receipt (Layer 4 — Mutual Receipt) ───────────────────────────────
    /**
     * Bob signs a receipt after receiving Alice's NFC payment.
     * Signed payload (sorted, canonical JSON):
     *   { fromCounter, nonce, payerUserId, receivedPaise, receiverDeviceId }
     *
     * The server verifies this signature against Bob's registered public key
     * BEFORE settling the transaction. Neither party can deny.
     */
    fun signReceipt(
        receivedPaise: Long,
        fromCounter: Long,
        payerUserId: String,
        receiverDeviceId: String,
        nonce: String,
        userId: String
    ): String {
        val obj = JSONObject().apply {
            put("fromCounter",      fromCounter)
            put("nonce",            nonce)
            put("payerUserId",      payerUserId)
            put("receivedPaise",    receivedPaise)
            put("receiverDeviceId", receiverDeviceId)
        }
        val sorted = JSONObject()
        obj.keys().asSequence().sorted().forEach { key -> sorted.put(key, obj.get(key)) }
        val canonical = sorted.toString()

        val keyPair = generateOrGetReceiptKeyPair(userId)
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(keyPair.private)
        signer.update(canonical.toByteArray())
        return Base64.getEncoder().encodeToString(signer.sign())
    }

    // ── Nonce generation ──────────────────────────────────────────────────────
    fun generateNonce(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
