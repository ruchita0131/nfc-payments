package com.nfcpay.ui

import android.content.Context
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.lifecycleScope
import com.nfcpay.R
import com.nfcpay.network.AuthRequest
import com.nfcpay.network.RegisterDeviceRequest
import com.nfcpay.network.RetrofitClient
import kotlinx.coroutines.launch
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import java.util.UUID

class LoginFragment : Fragment(R.layout.fragment_login) {

    private val viewModel: MainViewModel by activityViewModels()

    // KYC Tier options: displayed label → integer tier value
    private val kycOptions = listOf(
        "Tier 0 (Phone only)  —  ₹500 limit",
        "Tier 1 (Aadhaar)     —  ₹2,000 limit",
        "Tier 2 (Full KYC)    —  ₹5,000 limit"
    )

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val etUsername    = view.findViewById<EditText>(R.id.etUsername)
        val etPassword    = view.findViewById<EditText>(R.id.etPassword)
        val btnLogin      = view.findViewById<Button>(R.id.btnLogin)
        val btnRegister   = view.findViewById<Button>(R.id.btnRegister)
        val progressBar   = view.findViewById<ProgressBar>(R.id.progressBar)
        val llKycSection  = view.findViewById<LinearLayout>(R.id.llKycSection)
        val spinnerKyc    = view.findViewById<Spinner>(R.id.spinnerKycTier)

        // Populate KYC spinner
        val adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, kycOptions)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinnerKyc.adapter = adapter

        // Show/hide KYC section based on mode
        // Tapping "Register" shows the spinner; tapping "Login" hides it
        btnRegister.setOnClickListener {
            if (llKycSection.visibility == View.GONE) {
                // First tap: reveal KYC section and prompt user to confirm
                llKycSection.visibility = View.VISIBLE
                btnRegister.text = "Confirm Registration"
            } else {
                // Second tap: actually register
                val selectedTier = spinnerKyc.selectedItemPosition  // 0, 1, or 2
                performAuth(
                    username   = etUsername.text.toString(),
                    pass       = etPassword.text.toString(),
                    isRegister = true,
                    kycTier    = selectedTier,
                    progressBar = progressBar
                )
            }
        }

        btnLogin.setOnClickListener {
            llKycSection.visibility = View.GONE
            btnRegister.text = "Register"
            performAuth(
                username    = etUsername.text.toString(),
                pass        = etPassword.text.toString(),
                isRegister  = false,
                kycTier     = 0,
                progressBar = progressBar
            )
        }
    }

    private fun performAuth(
        username: String,
        pass: String,
        isRegister: Boolean,
        kycTier: Int,
        progressBar: ProgressBar
    ) {
        if (username.isBlank() || pass.isBlank()) {
            Toast.makeText(context, "Enter username and password", Toast.LENGTH_SHORT).show()
            return
        }

        progressBar.visibility = View.VISIBLE

        val prefs    = requireContext().getSharedPreferences("nfcpay", Context.MODE_PRIVATE)
        var deviceId = prefs.getString("nfc_device_id", null)
        if (deviceId == null) {
            deviceId = UUID.randomUUID().toString()
            prefs.edit().putString("nfc_device_id", deviceId).apply()
        }

        lifecycleScope.launch {
            try {
                val pubKeyB64 = generateAndGetPublicKey()
                val api = RetrofitClient.getApiService(requireContext())

                val req = AuthRequest(
                    username     = username,
                    password     = pass,
                    deviceId     = deviceId!!,
                    publicKeyB64 = pubKeyB64,
                    kycTier      = if (isRegister) kycTier else null
                )

                val response = if (isRegister) api.register(req) else api.login(req)

                if (response.success && response.data != null) {
                    val resolvedKycTier = response.data.kycTier

                    prefs.edit()
                        .putString("nfc_jwt", response.data.token)
                        .putString("username", response.data.username)
                        .putInt("kyc_tier", resolvedKycTier)
                        .apply()

                    // On login, re-register device key so server has current public key
                    if (!isRegister) {
                        try {
                            api.registerDevice(RegisterDeviceRequest(deviceId!!, pubKeyB64))
                        } catch (_: Exception) { /* non-fatal */ }
                    }

                    viewModel.checkLoginState()
                } else {
                    Toast.makeText(context, response.error ?: "Auth failed", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Toast.makeText(context, "Network error: ${e.message}", Toast.LENGTH_LONG).show()
            } finally {
                progressBar.visibility = View.GONE
            }
        }
    }

    private fun generateAndGetPublicKey(): String {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias    = "nfc_receipt_key"

        if (!keyStore.containsAlias(alias)) {
            val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            kpg.initialize(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build()
            )
            kpg.generateKeyPair()
        }

        return Base64.encodeToString(keyStore.getCertificate(alias).publicKey.encoded, Base64.NO_WRAP)
    }
}
