package com.nfcpay.ui

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import com.nfcpay.network.RetrofitClient
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val prefs = application.getSharedPreferences("nfcpay", Context.MODE_PRIVATE)

    private val _isLoggedIn = MutableLiveData<Boolean>()
    val isLoggedIn: LiveData<Boolean> = _isLoggedIn

    private val _username = MutableLiveData<String>()
    val username: LiveData<String> = _username

    private val _balanceRupees = MutableLiveData<String>()
    val balanceRupees: LiveData<String> = _balanceRupees

    private val _offlineRemainingRupees = MutableLiveData<String>()
    val offlineRemainingRupees: LiveData<String> = _offlineRemainingRupees

    init {
        checkLoginState()
    }

    fun checkLoginState() {
        val token = prefs.getString("nfc_jwt", null)
        val storedUsername = prefs.getString("username", "")
        if (!token.isNullOrEmpty()) {
            _isLoggedIn.value = true
            _username.value = storedUsername!!
            refreshBalance()
            loadOfflineTokenState()
        } else {
            _isLoggedIn.value = false
        }
    }

    fun logout() {
        prefs.edit().clear().apply()
        _isLoggedIn.value = false
    }

    fun refreshBalance() {
        viewModelScope.launch {
            try {
                val api = RetrofitClient.getApiService(getApplication())
                val response = api.getBalance()
                if (response.success && response.data != null) {
                    _balanceRupees.value = response.data.balanceRupees
                }
            } catch (e: Exception) {
                // Ignore errors or show toast in real app
            }
        }
    }

    fun loadOfflineTokenState() {
        val tokenJson = prefs.getString("current_token", null)
        if (tokenJson != null) {
            try {
                val json = JSONObject(tokenJson)
                val remainingPaise = json.getLong("offlineRemainingPaise")
                _offlineRemainingRupees.value = String.format("₹%.2f", remainingPaise / 100.0)
            } catch (e: Exception) {
                _offlineRemainingRupees.value = "₹0.00"
            }
        } else {
            _offlineRemainingRupees.value = "₹0.00"
        }
    }
}
