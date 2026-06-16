package com.nfcpay.sync

import android.content.Context
import android.util.Log
import androidx.work.*
import com.nfcpay.db.AppDatabase
import com.nfcpay.db.PendingTransaction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WorkManager background job — syncs pending transactions on reconnect.
 *
 * Triggered by:
 *   - NetworkConstraint satisfied (device comes back online)
 *   - Explicit call from WalletFragment after manual "Sync" tap
 *
 * The job:
 *   1. Reads all "pending" transactions from SQLite
 *   2. POSTs them to /api/transactions/sync
 *   3. Marks each as "synced" or "rejected" based on backend response
 *
 * The backend runs all 4 double-spend prevention layers on each transaction.
 */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    companion object {
        private const val TAG = "SyncWorker"
        private const val BASE_URL_KEY = "base_url"
        private const val JWT_KEY = "jwt"

        fun schedule(context: Context, baseUrl: String, jwt: String) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val work = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(constraints)
                .setInputData(workDataOf(BASE_URL_KEY to baseUrl, JWT_KEY to jwt))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context)
                .enqueueUniqueWork("nfcpay_sync", ExistingWorkPolicy.REPLACE, work)

            Log.d(TAG, "Sync job scheduled")
        }
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val baseUrl = inputData.getString(BASE_URL_KEY) ?: return@withContext Result.failure()
        val jwt     = inputData.getString(JWT_KEY) ?: return@withContext Result.failure()

        val db      = AppDatabase.getInstance(applicationContext)
        val pending = db.transactionDao().getPending()

        if (pending.isEmpty()) {
            Log.d(TAG, "No pending transactions to sync")
            return@withContext Result.success()
        }

        Log.i(TAG, "Syncing ${pending.size} pending transactions")

        try {
            val txnArray = JSONArray(pending.map { txn -> buildTxnJson(txn) })
            val body = JSONObject(mapOf("transactions" to txnArray)).toString()

            val request = Request.Builder()
                .url("$baseUrl/api/transactions/sync")
                .addHeader("Authorization", "Bearer $jwt")
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()

            val response = http.newCall(request).execute()
            val responseBody = response.body?.string() ?: return@withContext Result.retry()

            if (!response.isSuccessful) {
                Log.e(TAG, "Sync failed: ${response.code} $responseBody")
                return@withContext Result.retry()
            }

            val results = JSONObject(responseBody).getJSONArray("data")

            for (i in 0 until results.length()) {
                val result = results.getJSONObject(i)
                val clientTxnId = result.getString("clientTxnId")
                val status = if (result.getString("status") == "settled") "synced" else "rejected"
                db.transactionDao().updateStatus(clientTxnId, status)
                Log.d(TAG, "Txn $clientTxnId → $status")
            }

            Log.i(TAG, "Sync complete")
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Sync error", e)
            Result.retry()
        }
    }

    private fun buildTxnJson(txn: PendingTransaction): JSONObject {
        val nfcPayload = JSONObject(mapOf(
            "payerUserId"      to txn.payerUserId,
            "payerDeviceId"    to txn.payerDeviceId,
            "receiverDeviceId" to txn.receiverDeviceId,
            "amountPaise"      to txn.amountPaise,
            "counter"          to txn.counter,
            "nonce"            to txn.nonce,
            "tokenExpiresAt"   to txn.tokenExpiresAt,
            "hmac"             to txn.payerHmac,
        ))
        return JSONObject(mapOf(
            "clientTxnId"        to txn.clientTxnId,
            "payerDeviceId"      to txn.payerDeviceId,
            "receiverDeviceId"   to txn.receiverDeviceId,
            "amountPaise"        to txn.amountPaise,
            "counter"            to txn.counter,
            "nonce"              to txn.nonce,
            "payerHmac"          to txn.payerHmac,
            "nfcPayload"         to nfcPayload,
            "receiverReceiptSig" to (txn.receiverReceiptSig ?: ""),
            "tappedAt"           to java.time.Instant.ofEpochMilli(txn.tappedAt).toString(),
        ))
    }
}
