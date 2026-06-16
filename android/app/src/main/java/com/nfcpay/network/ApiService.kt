package com.nfcpay.network

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

interface ApiService {
    @POST("auth/login")
    suspend fun login(@Body request: AuthRequest): ApiResponse<AuthResponse>

    @POST("auth/register")
    suspend fun register(@Body request: AuthRequest): ApiResponse<AuthResponse>

    @POST("auth/register-device")
    suspend fun registerDevice(@Body request: RegisterDeviceRequest): ApiResponse<Any>

    @GET("wallet/balance")
    suspend fun getBalance(): ApiResponse<BalanceResponse>

    @GET("wallet/token")
    suspend fun getToken(
        @Query("deviceId") deviceId: String,
        @Query("sessionPublicKey") sessionPublicKey: String
    ): ApiResponse<WalletTokenResponse>

    @POST("wallet/load")
    suspend fun loadWallet(@Body request: LoadWalletRequest): ApiResponse<LoadWalletResponse>

    @POST("transactions/sync")
    suspend fun syncTransactions(@Body request: SyncRequest): ApiResponse<List<SyncResponseItem>>
}
