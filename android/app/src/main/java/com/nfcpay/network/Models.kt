package com.nfcpay.network

import com.google.gson.annotations.SerializedName

// Generic API Response
data class ApiResponse<T>(
    val success: Boolean,
    val data: T?,
    val error: String?
)

// Auth
data class AuthRequest(
    val username: String,
    val password: String,
    val deviceId: String,
    val publicKeyB64: String? = null,
    val kycTier: Int? = null  // only sent on register
)

data class AuthResponse(
    val token: String,
    val userId: String,
    val username: String,
    val kycTier: Int = 0
)

data class RegisterDeviceRequest(
    val deviceId: String,
    val publicKeyB64: String
)

// Wallet
data class BalanceResponse(
    val balancePaise: Long,
    val balanceRupees: String
)

data class LoadWalletRequest(
    val amountPaise: Long,
    val deviceId: String,
    val sessionPublicKey: String
)

data class WalletTokenResponse(
    val userId: String,
    val deviceId: String,
    val issuedBalancePaise: Long,
    val offlineLimitPaise: Long,
    val offlineSpentPaise: Long,
    val offlineRemainingPaise: Long,
    val counter: Long,
    val expiresAt: String,
    val sessionPublicKey: String,
    val hmac: String
)

data class LoadWalletResponse(
    val balancePaise: Long,
    val balanceRupees: String,
    val token: WalletTokenResponse
)

// Sync
data class SyncRequest(
    val transactions: List<SyncTransaction>
)

data class SyncTransaction(
    val clientTxnId: String,
    val payerDeviceId: String,
    val receiverDeviceId: String,
    val amountPaise: Long,
    val counter: Long,
    val nonce: String,
    val payerHmac: String,
    val nfcPayload: Map<String, Any>? = null, // Can pass null, backend reconstructs
    val receiverReceiptSig: String,
    val tappedAt: String
)

data class SyncResponseItem(
    val clientTxnId: String,
    val status: String,
    val rejectionReason: String?,
    val settledAt: String?
)
