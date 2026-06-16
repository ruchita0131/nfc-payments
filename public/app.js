/* ════════════════════════════════════════════════════════════
   NFC Pay — Dashboard JS
   Full SPA: auth, wallet, tap simulation, transaction history
════════════════════════════════════════════════════════════ */

const API = '/api';

// ─── State ───────────────────────────────────────────────────
let state = {
  token: null,
  userId: null,
  username: null,
  deviceId: null,
  pubKeyB64: null,
  privKeyRaw: null,
  lastTxn: null,
  authMode: 'login',
};

// ─── Init ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  state.deviceId = localStorage.getItem('nfc_device_id') || generateId();
  localStorage.setItem('nfc_device_id', state.deviceId);
  document.getElementById('auth-device').value = state.deviceId;

  const savedToken = localStorage.getItem('nfc_jwt');
  const savedUser  = localStorage.getItem('nfc_user');
  if (savedToken && savedUser) {
    const u = JSON.parse(savedUser);
    onLoginSuccess(savedToken, u.userId, u.username, u.kycTier);
  }

  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showView(el.dataset.view);
    });
  });

  // Attach event listeners to avoid CSP inline script issues
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('load-amount').addEventListener('input', updateLoadBtn);
  
  const tabLogin = document.getElementById('tab-login');
  if (tabLogin) tabLogin.addEventListener('click', () => switchAuthTab('login'));
  
  const tabRegister = document.getElementById('tab-register');
  if (tabRegister) tabRegister.addEventListener('click', () => switchAuthTab('register'));
  
  const authForm = document.getElementById('auth-form');
  if (authForm) authForm.addEventListener('submit', handleAuth);
  
  const refreshBalanceBtn = document.getElementById('refresh-balance-btn');
  if (refreshBalanceBtn) refreshBalanceBtn.addEventListener('click', refreshBalance);
  
  const loadForm = document.getElementById('load-form');
  if (loadForm) loadForm.addEventListener('submit', handleLoad);
  
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      setAmount(Number(e.target.dataset.amount));
    });
  });
  
  const startTapBtn = document.getElementById('start-tap-btn');
  if (startTapBtn) startTapBtn.addEventListener('click', startTapSimulation);
  
  const testDoubleSpendBtn = document.getElementById('test-double-spend-btn');
  if (testDoubleSpendBtn) testDoubleSpendBtn.addEventListener('click', testDoubleSpend);
  
  const refreshTxnsBtn = document.getElementById('refresh-txns-btn');
  if (refreshTxnsBtn) refreshTxnsBtn.addEventListener('click', loadTransactions);
});

// ─── Navigation ───────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.getElementById(`nav-${name}`).classList.add('active');
  if (name === 'dashboard')    loadDashboard();
  if (name === 'wallet')       refreshBalance();
  if (name === 'transactions') loadTransactions();
}

// ─── Auth ──────────────────────────────────────────────────────
function switchAuthTab(mode) {
  state.authMode = mode;
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('register-only').style.display = mode === 'register' ? 'flex' : 'none';
  document.getElementById('kyc-field').style.display = mode === 'register' ? 'flex' : 'none';
  document.getElementById('auth-submit').textContent = mode === 'login' ? 'Login' : 'Create Account';
  hideEl('auth-error');
}

async function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const submit   = document.getElementById('auth-submit');
  hideEl('auth-error');
  submit.disabled = true;
  submit.innerHTML = '<span class="spinner"></span>';

  try {
    const { pubKeyB64, privKey } = await generateKeyPair();
    state.pubKeyB64  = pubKeyB64;
    state.privKeyRaw = privKey;

    const endpoint = state.authMode === 'register' ? '/auth/register' : '/auth/login';
    const body = { username, password, deviceId: state.deviceId, publicKeyB64: pubKeyB64 };
    if (state.authMode === 'register') {
      body.kycTier = parseInt(document.getElementById('auth-kyc').value, 10) || 0;
    }
    const data = await apiFetch(endpoint, 'POST', body);
    onLoginSuccess(data.token, data.userId, data.username, data.kycTier);
  } catch (err) {
    showEl('auth-error', err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = state.authMode === 'login' ? 'Login' : 'Create Account';
  }
}

function onLoginSuccess(token, userId, username, kycTier) {
  state.token    = token;
  state.userId   = userId;
  state.username = username;
  state.kycTier  = kycTier || 0;
  localStorage.setItem('nfc_jwt',  token);
  localStorage.setItem('nfc_user', JSON.stringify({ userId, username, kycTier: state.kycTier }));
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('user-name-display').textContent = username;
  document.getElementById('user-kyc-display').textContent = `Tier ${state.kycTier}`;
  document.getElementById('user-avatar').textContent = username[0].toUpperCase();
  showView('dashboard');
}

function logout() {
  state = { ...state, token: null, userId: null, username: null };
  localStorage.removeItem('nfc_jwt');
  localStorage.removeItem('nfc_user');
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('user-name-display').textContent = 'Not logged in';
  document.getElementById('user-avatar').textContent = '?';
}

// ─── Dashboard ─────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const data = await apiFetch('/dashboard/stats');
    document.getElementById('stat-total-users').textContent   = data.total_users;
    document.getElementById('stat-settled-txns').textContent  = data.settled_txns;
    document.getElementById('stat-rejected-txns').textContent = data.rejected_txns;
    document.getElementById('stat-volume').textContent = formatRupees(parseInt(data.total_volume_paise || 0));
  } catch (err) { console.error('Dashboard load failed', err); }
}

// ─── Wallet ────────────────────────────────────────────────────
async function refreshBalance() {
  try {
    const data = await apiFetch('/wallet/balance', 'GET', null, true);
    document.getElementById('wallet-balance').textContent = data.balanceRupees;
    await refreshToken();
  } catch (err) { console.error('Balance refresh failed', err); }
}

async function refreshToken() {
  try {
    const params = `?deviceId=${encodeURIComponent(state.deviceId)}&sessionPublicKey=${encodeURIComponent(state.pubKeyB64 || 'placeholder')}`;
    const data = await apiFetch(`/wallet/token${params}`, 'GET', null, true);
    showTokenCard(data);
  } catch {
    document.getElementById('token-card').style.display = 'none';
  }
}

async function handleLoad(e) {
  e.preventDefault();
  const amountRupees = parseFloat(document.getElementById('load-amount').value);
  if (!amountRupees || amountRupees <= 0) return;
  const amountPaise = Math.round(amountRupees * 100);

  hideEl('load-error');
  hideEl('load-success');
  const btn = document.getElementById('load-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Loading...';

  try {
    const { pubKeyB64 } = await ensureKeyPair();
    const data = await apiFetch('/wallet/load', 'POST', {
      amountPaise,
      deviceId: state.deviceId,
      sessionPublicKey: pubKeyB64,
    }, true);
    document.getElementById('wallet-balance').textContent = data.balanceRupees || formatRupees(data.balancePaise);
    showEl('load-success', `✓ Loaded ${formatRupees(amountPaise)} successfully. New token issued.`);
    showTokenCard(data.token);
    document.getElementById('load-amount').value = '';
    updateLoadBtn();
  } catch (err) {
    showEl('load-error', err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Load \u20b9<span id="load-btn-amount">—</span>`;
    updateLoadBtn();
  }
}

function updateLoadBtn() {
  const val  = document.getElementById('load-amount').value;
  const span = document.getElementById('load-btn-amount');
  if (span) span.textContent = val ? parseFloat(val).toLocaleString('en-IN') : '—';
}

function setAmount(n) {
  document.getElementById('load-amount').value = n;
  updateLoadBtn();
}

function showTokenCard(token) {
  if (!token) return;
  document.getElementById('token-card').style.display = 'block';
  const expiry   = new Date(token.expiresAt);
  const isValid  = expiry > new Date();
  document.getElementById('token-display').innerHTML = `
    <div class="token-field"><div class="token-field-label">Balance (Issued)</div><div class="token-field-value green">${formatRupees(token.issuedBalancePaise)}</div></div>
    <div class="token-field"><div class="token-field-label">Offline Remaining</div><div class="token-field-value ${token.offlineRemainingPaise > 0 ? 'green' : 'amber'}">${formatRupees(token.offlineRemainingPaise)}</div></div>
    <div class="token-field"><div class="token-field-label">Offline Limit</div><div class="token-field-value">${formatRupees(token.offlineLimitPaise)}</div></div>
    <div class="token-field"><div class="token-field-label">Spending Counter</div><div class="token-field-value">${token.counter}</div></div>
    <div class="token-field"><div class="token-field-label">Expires At</div><div class="token-field-value ${isValid ? 'green' : 'amber'}">${expiry.toLocaleString()}</div></div>
    <div class="token-field"><div class="token-field-label">HMAC (SHA-256)</div><div class="token-field-value" style="font-size:0.7rem;color:var(--text-3)">${token.hmac?.substring(0,32)}…</div></div>
  `;
  document.getElementById('token-raw-json').textContent = JSON.stringify(token, null, 2);
}

// ─── Simulate NFC Tap ──────────────────────────────────────────
let tapState = {};

async function startTapSimulation() {
  const payerUsername    = document.getElementById('tap-payer').value.trim()    || 'alice';
  const receiverUsername = document.getElementById('tap-receiver').value.trim() || 'bob';
  const amountRupees     = parseFloat(document.getElementById('tap-amount').value) || 50;
  const amountPaise      = Math.round(amountRupees * 100);

  let limitPaise = 50000;
  if (state.kycTier === 1) limitPaise = 200000;
  if (state.kycTier === 2) limitPaise = 500000;

  if (amountPaise > limitPaise) { alert(`Amount exceeds ${formatRupees(limitPaise)} offline cap for your KYC Tier.`); return; }

  tapState = { payerUsername, receiverUsername, amountPaise };

  const btn = document.getElementById('start-tap-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Simulating...';

  document.getElementById('protocol-flow').style.display = 'block';
  document.getElementById('tap-result').style.display    = 'none';
  document.getElementById('double-spend-card').style.display = 'none';
  resetProtoSteps();

  try {
    // ── Step 1: Bob generates nonce challenge ────────────────
    await animateStep('proto-1', 'Bob generates nonce challenge...', null, 600);
    const nonce       = generateId(32);
    const bobDeviceId = `sim_bob_${state.deviceId}`;
    tapState.nonce       = nonce;
    tapState.bobDeviceId = bobDeviceId;
    await animateStep('proto-1', '✓ Nonce generated', JSON.stringify({ nonce, receiverDeviceId: bobDeviceId }, null, 2), 0, true);

    // ── Step 2: Alice builds signed NFC payload ──────────────
    await sleep(500);
    await animateStep('proto-2', 'Alice loading token & building payment payload...', null, 700);
    const tokenParams = `?deviceId=${encodeURIComponent(state.deviceId)}&sessionPublicKey=${encodeURIComponent(state.pubKeyB64 || 'sim_key')}`;
    let aliceToken;
    try {
      aliceToken = await apiFetch(`/wallet/token${tokenParams}`, 'GET', null, true);
    } catch {
      throw new Error(`${payerUsername} has no valid token. Go to Wallet → Top-Up first.`);
    }

    const nfcPayload = {
      payerUserId:      aliceToken.userId,
      payerDeviceId:    state.deviceId,
      receiverDeviceId: bobDeviceId,
      amountPaise,
      counter:          aliceToken.counter + 1,
      nonce,
      tokenExpiresAt:   aliceToken.expiresAt,
    };
    const payerHmac = await simulateHMAC(nfcPayload);
    nfcPayload.hmac  = payerHmac;
    tapState.nfcPayload = nfcPayload;
    tapState.payerHmac  = payerHmac;
    await animateStep('proto-2', '✓ Payment payload HMAC-signed', JSON.stringify(nfcPayload, null, 2), 0, true);

    // ── Step 3: Bob signs mutual receipt (Layer 4) ───────────
    await sleep(500);
    await animateStep('proto-3', 'Bob generating ECDSA keypair & signing mutual receipt...', null, 700);

    // Simulate Bob's Android Keystore: generate a fresh ECDSA keypair
    const bobKP = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const bobPubDer = await crypto.subtle.exportKey('spki', bobKP.publicKey);
    const bobPubB64 = btoa(String.fromCharCode(...new Uint8Array(bobPubDer)));

    // Register Bob's device key with the server so it can verify his receipt signature
    // (In real Android this happens once at user registration)
    await apiFetch('/auth/register-device', 'POST', { deviceId: bobDeviceId, publicKeyB64: bobPubB64 }, true);

    const receiptData = {
      fromCounter:      nfcPayload.counter,
      nonce,
      payerUserId:      aliceToken.userId,
      receivedPaise:    amountPaise,
      receiverDeviceId: bobDeviceId,
    };
    // Sign canonical sorted JSON
    const canonical = JSON.stringify(Object.keys(receiptData).sort().reduce((o, k) => ({ ...o, [k]: receiptData[k] }), {}));
    const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, bobKP.privateKey, new TextEncoder().encode(canonical));
    const receiptSig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    tapState.receiptSig = receiptSig;
    await animateStep('proto-3', '✓ Mutual receipt signed by Bob', JSON.stringify({ ...receiptData, sig: receiptSig.substring(0,32) + '…' }, null, 2), 0, true);

    // ── Step 4: Backend reconciliation — all 4 layers ────────
    await sleep(500);
    await animateStep('proto-4', 'Syncing to backend — checking all 4 double-spend layers...', null, 400);

    const syncBody = {
      transactions: [{
        clientTxnId:        generateId(),
        payerDeviceId:      state.deviceId,
        receiverDeviceId:   bobDeviceId,
        amountPaise,
        counter:            nfcPayload.counter,
        nonce,
        payerHmac,
        nfcPayload,
        receiverReceiptSig: receiptSig,
        tappedAt:           new Date().toISOString(),
      }]
    };

    tapState.syncBody = syncBody;
    const results = await apiFetch('/transactions/sync', 'POST', syncBody, true);
    const result  = results[0];

    if (result.status === 'settled') {
      await animateStep('proto-4', `✓ SETTLED at ${new Date(result.settledAt).toLocaleTimeString()}`, JSON.stringify(result, null, 2), 0, true);
      showTapResult(true, amountPaise, null);
      document.getElementById('double-spend-card').style.display = 'block';
    } else {
      await animateStep('proto-4', `✗ REJECTED — ${result.rejectionReason}`, JSON.stringify(result, null, 2), 0, false, true);
      showTapResult(false, amountPaise, result.rejectionReason);
    }

    state.lastTxn = { syncBody, result };
    await refreshBalance();
    await loadDashboard();

  } catch (err) {
    const el = document.getElementById('proto-4');
    el.classList.add('error');
    document.getElementById('proto-msg-4').textContent = `✗ Error: ${err.message}`;
    showTapResult(false, tapState.amountPaise || 0, err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '⟳ Start Tap';
  }
}

async function testDoubleSpend() {
  if (!state.lastTxn) return;
  const resultEl = document.getElementById('double-spend-result');
  resultEl.style.display = 'block';
  resultEl.textContent = 'Replaying same transaction…';
  try {
    const results = await apiFetch('/transactions/sync', 'POST', state.lastTxn.syncBody, true);
    const result  = results[0];
    if (result.status === 'rejected') {
      resultEl.textContent = `✓ Attack blocked!\nStatus: REJECTED\nReason: ${result.rejectionReason}\n\nLayer 1 (seen_counters) caught the duplicate (userId, counter) pair instantly.`;
      resultEl.style.color = 'var(--green)';
    } else {
      resultEl.textContent = `⚠️ DOUBLE SPEND SUCCEEDED — this is a bug!`;
      resultEl.style.color = 'var(--red)';
    }
  } catch (err) {
    resultEl.textContent = `Error: ${err.message}`;
  }
}

function showTapResult(success, amountPaise, reason) {
  const el = document.getElementById('tap-result');
  el.style.display = 'block';
  el.className = `tap-result ${success ? 'success' : 'failure'}`;
  el.innerHTML = success
    ? `<div class="result-icon">✓</div><div class="result-title">${formatRupees(amountPaise)} settled</div><div class="result-sub">All 4 double-spend layers passed. Balances updated.</div>`
    : `<div class="result-icon">✗</div><div class="result-title">Transaction rejected</div><div class="result-sub">${reason || 'Unknown error'}</div>`;
}

function resetProtoSteps() {
  [1,2,3,4].forEach(i => {
    const el = document.getElementById(`proto-${i}`);
    el.classList.remove('done', 'error');
    document.getElementById(`proto-msg-${i}`).textContent = i === 1 ? 'Generating...' : 'Waiting...';
    const code = document.getElementById(`proto-code-${i}`);
    if (code) { code.style.display = 'none'; code.textContent = ''; }
  });
}

async function animateStep(id, msg, codeStr, waitMs, done = false, error = false) {
  await sleep(waitMs);
  const el  = document.getElementById(id);
  const num = id.split('-')[1];
  el.classList.toggle('done',  done && !error);
  el.classList.toggle('error', error);
  document.getElementById(`proto-msg-${num}`).textContent = msg;
  if (codeStr) {
    const code = document.getElementById(`proto-code-${num}`);
    code.textContent = codeStr;
    code.style.display = 'block';
  }
}

// ─── Transaction History ───────────────────────────────────────
async function loadTransactions() {
  try {
    const data = await apiFetch('/transactions/history', 'GET', null, true);
    const tbody = document.getElementById('txn-tbody');
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No transactions yet. Simulate a tap first.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(t => {
      const dir   = t.direction === 'sent' ? 'sent' : 'received';
      const party = dir === 'sent' ? t.receiver_username : t.payer_username;
      const badge = t.status === 'settled'
        ? `<span class="badge badge-green">settled</span>`
        : `<span class="badge badge-red">rejected</span>`;
      return `<tr>
        <td class="dir-${dir}">${dir === 'sent' ? '↑ Sent' : '↓ Received'}</td>
        <td>${escHtml(party)}</td>
        <td style="font-family:var(--font-mono)">${formatRupees(t.amount_paise)}</td>
        <td>${badge}</td>
        <td style="font-size:0.8rem;color:var(--text-3)">${fmtDate(t.tapped_at)}</td>
        <td style="font-size:0.8rem;color:var(--text-3)">${t.settled_at ? fmtDate(t.settled_at) : '—'}</td>
        <td style="font-size:0.75rem;color:var(--red)">${t.rejection_reason || '—'}</td>
      </tr>`;
    }).join('');
  } catch (err) { console.error('Transaction load failed', err); }
}

// ─── API helpers ───────────────────────────────────────────────
async function apiFetch(path, method = 'GET', body = null, auth = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res  = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || json.errors?.[0]?.msg || 'Request failed');
  return json.data;
}

// ─── Crypto helpers ────────────────────────────────────────────
async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = await crypto.subtle.exportKey('spki', kp.publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  state.privKeyRaw = kp.privateKey;
  return { pubKeyB64: b64, privKey: kp.privateKey };
}

async function ensureKeyPair() {
  if (!state.pubKeyB64 || !state.privKeyRaw) return generateKeyPair();
  return { pubKeyB64: state.pubKeyB64, privKey: state.privKeyRaw };
}

async function simulateHMAC(payload) {
  const data = JSON.stringify(Object.keys(payload).sort().reduce((o, k) => ({ ...o, [k]: payload[k] }), {}));
  const key  = await crypto.subtle.importKey('raw', new TextEncoder().encode('sim_browser_key_32bytes_padding!!'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ─── Utilities ─────────────────────────────────────────────────
function generateId(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2,'0')).join('');
}
function formatRupees(paise) { return `\u20b9${(paise / 100).toFixed(2)}`; }
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
}
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showEl(id, text) { const e = document.getElementById(id); if (!e) return; e.style.display = 'block'; if (text !== undefined) e.textContent = text; }
function hideEl(id) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
