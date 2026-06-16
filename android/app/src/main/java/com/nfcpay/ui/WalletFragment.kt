package com.nfcpay.ui

import android.content.Context
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import com.google.gson.Gson
import com.nfcpay.R
import com.nfcpay.network.LoadWalletRequest
import com.nfcpay.network.RetrofitClient
import kotlinx.coroutines.launch

class WalletFragment : Fragment(R.layout.fragment_wallet) {

    private val viewModel: MainViewModel by activityViewModels()

    // Maps kyc_tier → offline limit in paise (mirrors backend getOfflineLimitPaise())
    private fun offlineLimitPaiseFor(kycTier: Int) = when (kycTier) {
        2    -> 500_000L  // ₹5,000
        1    -> 200_000L  // ₹2,000
        else ->  50_000L  // ₹500
    }

    private fun formatRupees(paise: Long) = "₹${String.format("%.2f", paise / 100.0)}"

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val tvBalance          = view.findViewById<TextView>(R.id.tvBalance)
        val tvOfflineRemaining = view.findViewById<TextView>(R.id.tvOfflineRemaining)
        val etLoadAmount       = view.findViewById<EditText>(R.id.etLoadAmount)
        val btnLoadWallet      = view.findViewById<Button>(R.id.btnLoadWallet)

        val prefs   = requireContext().getSharedPreferences("nfcpay", Context.MODE_PRIVATE)
        val kycTier = prefs.getInt("kyc_tier", 0)
        val limitPaise = offlineLimitPaiseFor(kycTier)

        // Show the cap upfront so user knows what they're loading
        tvOfflineRemaining.text = "Offline cap: ${formatRupees(limitPaise)}  (KYC Tier $kycTier)"

        viewModel.balanceRupees.observe(viewLifecycleOwner) { balance ->
            tvBalance.text = balance
        }

        viewModel.offlineRemainingRupees.observe(viewLifecycleOwner) { remaining ->
            tvOfflineRemaining.text = "Offline Token: $remaining remaining  (cap ${formatRupees(limitPaise)})"
        }

        btnLoadWallet.setOnClickListener {
            val amountStr = etLoadAmount.text.toString()
            if (amountStr.isBlank()) return@setOnClickListener

            val amountRupees = amountStr.toLongOrNull() ?: return@setOnClickListener
            val amountPaise  = amountRupees * 100

            if (amountPaise > limitPaise) {
                Toast.makeText(context, "Amount exceeds your offline cap of ${formatRupees(limitPaise)} (Tier $kycTier)", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }

            val deviceId  = prefs.getString("nfc_device_id", "") ?: ""
            val pubKeyB64 = getPublicKeyB64()

            btnLoadWallet.isEnabled = false

            lifecycleScope.launch {
                try {
                    val api     = RetrofitClient.getApiService(requireContext())
                    val request = LoadWalletRequest(amountPaise, deviceId, pubKeyB64)
                    val response = api.loadWallet(request)

                    if (response.success && response.data != null) {
                        prefs.edit()
                            .putString("current_token", Gson().toJson(response.data.token))
                            .apply()

                        viewModel.refreshBalance()
                        viewModel.loadOfflineTokenState()
                        etLoadAmount.text.clear()
                        Toast.makeText(context, "Wallet loaded ✓", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(context, response.error ?: "Load failed", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(context, "Network error: ${e.message}", Toast.LENGTH_SHORT).show()
                } finally {
                    btnLoadWallet.isEnabled = true
                }
            }
        }
    }

    private fun getPublicKeyB64(): String {
        return try {
            val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            Base64.encodeToString(keyStore.getCertificate("nfc_receipt_key").publicKey.encoded, Base64.NO_WRAP)
        } catch (_: Exception) { "" }
    }
}
