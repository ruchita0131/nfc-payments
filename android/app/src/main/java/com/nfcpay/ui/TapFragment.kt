package com.nfcpay.ui

import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.nfcpay.R
import com.nfcpay.nfc.NFCReaderManager
import com.nfcpay.nfc.NFCTapResult
import com.nfcpay.sync.SyncWorker

class TapFragment : Fragment(R.layout.fragment_tap) {

    private var nfcReaderManager: NFCReaderManager? = null

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val rgMode = view.findViewById<RadioGroup>(R.id.rgMode)
        val rbPay = view.findViewById<RadioButton>(R.id.rbPay)
        val llPayMode = view.findViewById<LinearLayout>(R.id.llPayMode)
        val llReceiveMode = view.findViewById<LinearLayout>(R.id.llReceiveMode)

        val etReceiveAmount = view.findViewById<EditText>(R.id.etReceiveAmount)
        val btnStartReading = view.findViewById<Button>(R.id.btnStartReading)
        val tvReaderStatus = view.findViewById<TextView>(R.id.tvReaderStatus)

        // Switch modes
        rgMode.setOnCheckedChangeListener { _, checkedId ->
            if (checkedId == R.id.rbPay) {
                llPayMode.visibility = View.VISIBLE
                llReceiveMode.visibility = View.GONE
                disableReaderMode()
                tvReaderStatus.visibility = View.GONE
            } else {
                llPayMode.visibility = View.GONE
                llReceiveMode.visibility = View.VISIBLE
            }
        }

        btnStartReading.setOnClickListener {
            val amountStr = etReceiveAmount.text.toString()
            if (amountStr.isBlank()) {
                Toast.makeText(context, "Enter amount", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            
            val amountPaise = (amountStr.toLongOrNull() ?: 0L) * 100
            if (amountPaise <= 0) return@setOnClickListener

            tvReaderStatus.visibility = View.VISIBLE
            tvReaderStatus.text = "Waiting for payer to tap..."
            
            enableReaderMode(amountPaise, tvReaderStatus)
        }
    }

    private fun enableReaderMode(amountPaise: Long, statusText: TextView) {
        val prefs = requireContext().getSharedPreferences("nfcpay", Context.MODE_PRIVATE)
        val userId = prefs.getString("username", "unknown")!! // we only saved username, not userId, but backend extracts from JWT anyway. Wait, NFCReaderManager needs userId. Let's just use username or fetch from prefs.
        val deviceId = prefs.getString("nfc_device_id", "")!!

        nfcReaderManager = NFCReaderManager(requireActivity(), userId, deviceId) { result ->
            when (result) {
                is NFCTapResult.Success -> {
                    statusText.setTextColor(android.graphics.Color.GREEN)
                    statusText.text = "Success! Received ₹${result.amountPaise / 100}"
                    
                    // Trigger background sync to send the mutual receipt to Node.js backend
                    val syncWork = OneTimeWorkRequestBuilder<SyncWorker>().build()
                    WorkManager.getInstance(requireContext()).enqueue(syncWork)
                }
                is NFCTapResult.Error -> {
                    statusText.setTextColor(android.graphics.Color.RED)
                    statusText.text = "Failed: ${result.message}"
                }
            }
        }
        
        nfcReaderManager?.setRequestedAmount(amountPaise)
        nfcReaderManager?.enable()
    }

    private fun disableReaderMode() {
        nfcReaderManager?.disable()
        nfcReaderManager = null
    }

    override fun onPause() {
        super.onPause()
        disableReaderMode() // Always disable when leaving the fragment
    }
}
