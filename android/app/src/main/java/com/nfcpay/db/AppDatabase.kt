package com.nfcpay.db

import androidx.room.*
import kotlinx.coroutines.flow.Flow

// ─── Entity ───────────────────────────────────────────────────
@Entity(tableName = "pending_transactions")
data class PendingTransaction(
    @PrimaryKey val clientTxnId: String,
    val payerUserId: String,
    val payerDeviceId: String,
    val receiverDeviceId: String,
    val amountPaise: Long,
    val counter: Long,
    val nonce: String,
    val payerHmac: String,
    val receiverReceiptSig: String?,
    val tokenExpiresAt: String,
    val tappedAt: Long,          // epoch millis (device clock)
    val status: String,          // "pending" | "synced" | "rejected"
)

// ─── Token Payload (cached locally) ──────────────────────────
data class TokenPayload(
    val userId: String,
    val deviceId: String,
    val issuedBalancePaise: Long,
    val offlineLimitPaise: Long,
    val offlineSpentPaise: Long,
    val offlineRemainingPaise: Long,
    val counter: Long,
    val expiresAt: String,
    val issuedAt: String,
    val sessionPublicKey: String,
    val hmac: String,
)

// ─── DAO ──────────────────────────────────────────────────────
@Dao
interface TransactionDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertPending(txn: PendingTransaction)

    @Query("SELECT * FROM pending_transactions WHERE status = 'pending' ORDER BY tappedAt ASC")
    suspend fun getPending(): List<PendingTransaction>

    @Query("SELECT * FROM pending_transactions ORDER BY tappedAt DESC")
    fun observeAll(): Flow<List<PendingTransaction>>

    @Query("UPDATE pending_transactions SET status = :status WHERE clientTxnId = :id")
    suspend fun updateStatus(id: String, status: String)
}

// ─── Database ─────────────────────────────────────────────────
@Database(entities = [PendingTransaction::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun transactionDao(): TransactionDao

    companion object {
        @Volatile private var INSTANCE: AppDatabase? = null

        fun getInstance(context: android.content.Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, "nfcpay.db")
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
