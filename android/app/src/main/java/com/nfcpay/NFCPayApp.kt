package com.nfcpay

import android.app.Application
import com.nfcpay.db.AppDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class NFCPayApp : Application() {
    
    // Application-scoped coroutine scope
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        
        // Initialize the local SQLite database early
        applicationScope.launch {
            AppDatabase.getInstance(this@NFCPayApp)
        }
    }
}
