package com.nfcpay.nfc

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.util.Log
import com.nfcpay.crypto.HMACHelper
import com.nfcpay.db.AppDatabase
import com.nfcpay.db.PendingTransaction
import kotlinx.coroutines.*
import org.json.JSONObject
import java.util.UUID

/**
 * NFC Reader — Bob's Side
 *
 * Bob's phone acts as a contactless card READER (like a POS terminal).
 * When Alice's phone is tapped, IsoDep connects over NFC and this
 * class drives the 3-message protocol:
 *
 *   1. SELECT AID → confirm Alice is running our HCE service
 *   2. Send nonce challenge → receive signed payment APDU from Alice
 *   3. Verify payment → sign mutual receipt → send receipt to Alice
 *
 * The full transaction is then stored in SQLite for server sync.
 */
class NFCReaderManager(
    private val activity: Activity,
    private val userId: String,
    private val deviceId: String,
    private val onResult: (NFCTapResult) -> Unit
) : NfcAdapter.ReaderCallback {

    companion object {
        private const val TAG = "NFCReader"
        private val AID = PaymentHCEHelper.hexStringToBytes("F06E666370617931")

        // SELECT AID APDU: CLA=0x00 INS=0xA4 P1=0x04 P2=0x00 Lc=8 AID
        private fun buildSelectAidApdu(): ByteArray =
            byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, AID.size.toByte()) + AID
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun enable() {
        NfcAdapter.getDefaultAdapter(activity)?.enableReaderMode(
            activity,
            this,
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
            null
        )
    }

    fun disable() {
        NfcAdapter.getDefaultAdapter(activity)?.disableReaderMode(activity)
    }

    override fun onTagDiscovered(tag: Tag?) {
        val isoDep = IsoDep.get(tag) ?: return
        scope.launch {
            try {
                isoDep.connect()
                isoDep.timeout = 5000

                // ── Step 1: SELECT AID ────────────────────────────────────────
                val selectResponse = isoDep.transceive(buildSelectAidApdu())
                if (!isSwOk(selectResponse)) {
                    notifyResult(NFCTapResult.Error("Device not running NFCPay"))
                    return@launch
                }
                Log.d(TAG, "AID selected successfully")

                // ── Step 2: Send nonce challenge ──────────────────────────────
                val nonce = HMACHelper.generateNonce()
                val amountPaise = getRequestedAmount() // Set by TapFragment before enabling reader

                val nonceChallenge = JSONObject(mapOf(
                    "nonce"            to nonce,
                    "receiverDeviceId" to deviceId,
                    "amountPaise"      to amountPaise,
                ))

                val nonceApdu = byteArrayOf(0x01) + nonceChallenge.toString().toByteArray()
                val paymentResponse = isoDep.transceive(nonceApdu)

                if (!isSwOk(paymentResponse)) {
                    val errMsg = String(paymentResponse.dropLast(2).toByteArray())
                    notifyResult(NFCTapResult.Error("Payment refused: $errMsg"))
                    return@launch
                }

                // Parse Alice's signed payment payload
                val paymentData = JSONObject(String(paymentResponse.dropLast(2).toByteArray()))
                Log.d(TAG, "Payment received: $paymentData")

                // Basic sanity checks (server re-verifies HMAC)
                if (paymentData.getLong("amountPaise") != amountPaise) {
                    notifyResult(NFCTapResult.Error("Amount mismatch"))
                    return@launch
                }
                if (paymentData.getString("nonce") != nonce) {
                    notifyResult(NFCTapResult.Error("Nonce mismatch — possible replay!"))
                    return@launch
                }

                val payerUserId  = paymentData.getString("payerUserId")
                val fromCounter  = paymentData.getLong("counter")

                // ── Step 3: Sign mutual receipt (Layer 4) ─────────────────────
                val receiptSig = HMACHelper.signReceipt(
                    receivedPaise    = amountPaise,
                    fromCounter      = fromCounter,
                    payerUserId      = payerUserId,
                    receiverDeviceId = deviceId,
                    nonce            = nonce,
                    userId           = userId
                )

                val receipt = JSONObject(mapOf(
                    "receivedPaise"    to amountPaise,
                    "fromCounter"      to fromCounter,
                    "payerUserId"      to payerUserId,
                    "receiverDeviceId" to deviceId,
                    "nonce"            to nonce,
                    "sig"              to receiptSig,
                ))

                val receiptApdu = byteArrayOf(0x03) + receipt.toString().toByteArray()
                val ackResponse = isoDep.transceive(receiptApdu)

                if (!isSwOk(ackResponse)) {
                    notifyResult(NFCTapResult.Error("Receipt ack failed"))
                    return@launch
                }

                // ── Store pending transaction (receiver side) ──────────────────
                val db = AppDatabase.getInstance(activity.applicationContext)
                val txn = PendingTransaction(
                    clientTxnId        = UUID.randomUUID().toString(),
                    payerUserId        = payerUserId,
                    payerDeviceId      = paymentData.getString("payerDeviceId"),
                    receiverDeviceId   = deviceId,
                    amountPaise        = amountPaise,
                    counter            = fromCounter,
                    nonce              = nonce,
                    payerHmac          = paymentData.optString("hmac"),
                    receiverReceiptSig = receiptSig,
                    tokenExpiresAt     = paymentData.getString("tokenExpiresAt"),
                    tappedAt           = System.currentTimeMillis(),
                    status             = "pending"
                )
                db.transactionDao().insertPending(txn)

                Log.i(TAG, "NFC tap complete — ₹${amountPaise/100} from $payerUserId, counter=$fromCounter")
                notifyResult(NFCTapResult.Success(amountPaise, payerUserId, fromCounter))

            } catch (e: Exception) {
                Log.e(TAG, "NFC error", e)
                notifyResult(NFCTapResult.Error(e.message ?: "NFC error"))
            } finally {
                runCatching { isoDep.close() }
            }
        }
    }

    private fun isSwOk(response: ByteArray): Boolean {
        if (response.size < 2) return false
        return response[response.size - 2] == 0x90.toByte() &&
               response[response.size - 1] == 0x00.toByte()
    }

    private fun notifyResult(result: NFCTapResult) {
        activity.runOnUiThread { onResult(result) }
    }

    // This would normally be set by TapFragment before enabling the reader
    private var requestedAmountPaise: Long = 5000L // ₹50 default
    fun setRequestedAmount(paise: Long) { requestedAmountPaise = paise }
    private fun getRequestedAmount() = requestedAmountPaise
}

sealed class NFCTapResult {
    data class Success(val amountPaise: Long, val payerUserId: String, val counter: Long) : NFCTapResult()
    data class Error(val message: String) : NFCTapResult()
}

// Re-export hex util from HCE service
private object PaymentHCEHelper {
    fun hexStringToBytes(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
