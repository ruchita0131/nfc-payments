package com.nfcpay.hce

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import android.util.Log
import com.nfcpay.crypto.HMACHelper
import com.nfcpay.db.AppDatabase
import com.nfcpay.db.PendingTransaction
import kotlinx.coroutines.*
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

/**
 * Host Card Emulation (HCE) Service — Alice's Side
 *
 * When Bob's phone taps Alice's phone, the Android NFC stack calls processCommandApdu()
 * here. This service makes Alice's phone behave identically to a Visa payWave card
 * responding to an EMV terminal.
 *
 * ── Protocol (3 messages over NFC) ────────────────────────────────────────────
 *
 *  Bob  →  Alice  :  SELECT AID (F06E666370617931)
 *  Alice → Bob    :  SW 9000 (OK, ready)
 *
 *  Bob  →  Alice  :  { nonce, receiverDeviceId }   ← nonce challenge
 *  Alice → Bob    :  { amount, counter, nonce, receiverDeviceId, hmac } ← signed payment
 *
 *  Bob  →  Alice  :  { receivedPaise, fromCounter, sig } ← mutual receipt
 *  Alice          :  stores pending transaction in SQLite
 *
 * ── State machine ─────────────────────────────────────────────────────────────
 * IDLE → AID_SELECTED → NONCE_RECEIVED → PAYMENT_SENT → RECEIPT_RECEIVED
 */
class PaymentHCEService : HostApduService() {

    companion object {
        private const val TAG = "NFCPayHCE"

        // Our custom AID — F0 prefix = proprietary (not a real payment network AID)
        private val SELECT_AID_HEADER = byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00)
        private val TARGET_AID = hexStringToBytes("F06E666370617931")

        // APDU status words
        val SW_OK              = byteArrayOf(0x90.toByte(), 0x00)
        val SW_NOT_FOUND       = byteArrayOf(0x6A, 0x82.toByte())
        val SW_UNKNOWN         = byteArrayOf(0x6F, 0x00)
        val SW_CONDITIONS      = byteArrayOf(0x69, 0x85.toByte())

        // Custom command bytes (first byte after header)
        const val CMD_NONCE    = 0x01.toByte()
        const val CMD_PAYMENT  = 0x02.toByte()
        const val CMD_RECEIPT  = 0x03.toByte()

        fun hexStringToBytes(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }

    private enum class State { IDLE, AID_SELECTED, PAYMENT_SENT }
    private var hceState = State.IDLE

    // Captured from Bob's nonce challenge
    private var pendingNonce: String? = null
    private var pendingReceiverDeviceId: String? = null
    private var pendingAmountPaise: Long = 0
    private var pendingCounter: Long = 0

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // ── APDU handler ──────────────────────────────────────────────────────────
    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        if (commandApdu == null) return SW_UNKNOWN

        Log.d(TAG, "APDU received: ${commandApdu.joinToString(" ") { "%02X".format(it) }}")

        return when {
            isSelectAid(commandApdu)         -> handleSelectAid()
            isNonceCommand(commandApdu)       -> handleNonceChallenge(commandApdu)
            isReceiptCommand(commandApdu)     -> handleReceiptAck(commandApdu)
            else -> SW_UNKNOWN
        }
    }

    // ── Step 1: SELECT AID ────────────────────────────────────────────────────
    private fun isSelectAid(apdu: ByteArray): Boolean {
        if (apdu.size < SELECT_AID_HEADER.size + TARGET_AID.size) return false
        val header = apdu.take(4).toByteArray()
        val aidLen = apdu[4].toInt()
        if (4 + 1 + aidLen > apdu.size) return false
        val aid = apdu.drop(5).take(aidLen).toByteArray()
        return header.contentEquals(SELECT_AID_HEADER) && aid.contentEquals(TARGET_AID)
    }

    private fun handleSelectAid(): ByteArray {
        hceState = State.AID_SELECTED
        Log.d(TAG, "AID selected — HCE session started")
        return SW_OK
    }

    // ── Step 2: Receive nonce challenge, send signed payment ──────────────────
    private fun isNonceCommand(apdu: ByteArray) =
        hceState == State.AID_SELECTED && apdu.isNotEmpty() && apdu[0] == CMD_NONCE

    private fun handleNonceChallenge(apdu: ByteArray): ByteArray {
        try {
            val json = JSONObject(String(apdu.drop(1).toByteArray()))
            val nonce = json.getString("nonce")
            val receiverDeviceId = json.getString("receiverDeviceId")
            val amountPaise = json.getLong("amountPaise")

            // Load token from SharedPreferences (set by WalletFragment after /wallet/load)
            val prefs = getSharedPreferences("nfcpay", MODE_PRIVATE)
            val tokenJson = prefs.getString("current_token", null)
                ?: return buildError("No token — load wallet first")

            val token = JSONObject(tokenJson)
            val remainingPaise = token.getLong("offlineRemainingPaise")

            // ── Offline cap enforcement (Layer 2) ────────────────────────────
            if (amountPaise > remainingPaise) {
                Log.w(TAG, "Offline cap exceeded: requested=$amountPaise remaining=$remainingPaise")
                return buildError("OFFLINE_CAP_EXCEEDED")
            }

            // ── Token expiry check (Layer 2) ─────────────────────────────────
            val expiresAt = token.getString("expiresAt")
            if (java.time.Instant.parse(expiresAt).isBefore(java.time.Instant.now())) {
                return buildError("TOKEN_EXPIRED")
            }

            // ── Increment counter ─────────────────────────────────────────────
            val newCounter = token.getLong("counter") + 1
            val userId = token.getString("userId")
            val deviceId = token.getString("deviceId")

            // Build signed NFC payload (Layer 3 — nonce binds to this receiver)
            val paymentPayload = JSONObject().apply {
                put("payerUserId",      userId)
                put("payerDeviceId",    deviceId)
                put("receiverDeviceId", receiverDeviceId)
                put("amountPaise",      amountPaise)
                put("counter",          newCounter)
                put("nonce",            nonce)
                put("tokenExpiresAt",   expiresAt)
            }

            // HMAC over sorted canonical JSON
            // Note: In HMAC mode, the backend re-derives the real HMAC on sync.
            // The device signs with its cached HMAC key (received from server).
            // Production: replace with ECDSA so receiver can verify offline.
            val hmacKey = Base64.getDecoder().decode(prefs.getString("hmac_key", "") ?: "")
            val hmacSig = HMACHelper.hmacSha256(paymentPayload.toString(), hmacKey)
            paymentPayload.put("hmac", hmacSig)

            // Update local token state
            val updatedToken = JSONObject(tokenJson).apply {
                put("counter", newCounter)
                put("offlineSpentPaise", token.getLong("offlineSpentPaise") + amountPaise)
                put("offlineRemainingPaise", remainingPaise - amountPaise)
            }
            prefs.edit().putString("current_token", updatedToken.toString()).apply()

            // Store tap data for when receipt arrives
            pendingNonce = nonce
            pendingReceiverDeviceId = receiverDeviceId
            pendingAmountPaise = amountPaise
            pendingCounter = newCounter
            hceState = State.PAYMENT_SENT

            Log.d(TAG, "Payment APDU sent: ₹${amountPaise/100} counter=$newCounter nonce=$nonce")
            return paymentPayload.toString().toByteArray() + SW_OK

        } catch (e: Exception) {
            Log.e(TAG, "handleNonceChallenge error", e)
            return buildError(e.message ?: "Unknown error")
        }
    }

    // ── Step 3: Receive Bob's mutual receipt ──────────────────────────────────
    private fun isReceiptCommand(apdu: ByteArray) =
        hceState == State.PAYMENT_SENT && apdu.isNotEmpty() && apdu[0] == CMD_RECEIPT

    private fun handleReceiptAck(apdu: ByteArray): ByteArray {
        try {
            val json = JSONObject(String(apdu.drop(1).toByteArray()))
            val receiptSig = json.getString("sig")

            // Persist pending transaction to SQLite for sync
            val prefs = getSharedPreferences("nfcpay", MODE_PRIVATE)
            val tokenJson = prefs.getString("current_token", null) ?: return SW_CONDITIONS

            val token = JSONObject(tokenJson)

            serviceScope.launch {
                val db = AppDatabase.getInstance(applicationContext)
                db.transactionDao().insertPending(
                    PendingTransaction(
                        clientTxnId        = UUID.randomUUID().toString(),
                        payerUserId        = token.getString("userId"),
                        payerDeviceId      = token.getString("deviceId"),
                        receiverDeviceId   = pendingReceiverDeviceId!!,
                        amountPaise        = pendingAmountPaise,
                        counter            = pendingCounter,
                        nonce              = pendingNonce!!,
                        payerHmac          = "",  // will be recomputed server-side
                        receiverReceiptSig = receiptSig,
                        tokenExpiresAt     = token.getString("expiresAt"),
                        tappedAt           = System.currentTimeMillis(),
                        status             = "pending"
                    )
                )
                Log.i(TAG, "Pending transaction stored for sync")
            }

            hceState = State.IDLE
            return SW_OK

        } catch (e: Exception) {
            Log.e(TAG, "handleReceiptAck error", e)
            return buildError(e.message ?: "Unknown error")
        }
    }

    private fun buildError(msg: String): ByteArray {
        return ("ERR:$msg").toByteArray() + SW_CONDITIONS
    }

    override fun onDeactivated(reason: Int) {
        Log.d(TAG, "HCE deactivated, reason=$reason")
        hceState = State.IDLE
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
    }
}
