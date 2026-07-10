// ============================================================
// Number Switcher — Frontend Application Logic
// Secured with RingCentral OAuth — No agent dropdown
//
// Flow:
//   1. Check /api/auth/me → authenticated or not
//   2. If not → show login button
//   3. If yes → load agent's number + inventory, show switch UI
//   4. Switch sends POST /api/switch-number (no extensionId in body)
// ============================================================

const API_BASE = '';

// ── State ──
let agentInfo = null;       // { extensionId, extensionName, extensionNumber }
let currentDirectNumber = null;
let inventoryNumbers = [];
let activeJobId = null;
let pollTimer = null;
let cooldownTimer = null;

// ── DOM Elements ──
const stateLoading = document.getElementById('stateLoading');
const stateLogin = document.getElementById('stateLogin');
const stateAuthenticated = document.getElementById('stateAuthenticated');
const authError = document.getElementById('authError');
const authErrorText = document.getElementById('authErrorText');

const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const userExt = document.getElementById('userExt');
const btnLogout = document.getElementById('btnLogout');

const currentNumberDisplay = document.getElementById('currentNumberDisplay');
const currentNumberValue = document.getElementById('currentNumberValue');
const currentNumberMeta = document.getElementById('currentNumberMeta');
const inventoryInfo = document.getElementById('inventoryInfo');
const inventoryCount = document.getElementById('inventoryCount');
const btnSwitch = document.getElementById('btnSwitch');
const resultArea = document.getElementById('resultArea');
const resultContent = document.getElementById('resultContent');
const historyList = document.getElementById('historyList');
const historyCard = document.getElementById('historyCard');
const confirmModal = document.getElementById('confirmModal');
const confirmDetails = document.getElementById('confirmDetails');
const btnCancel = document.getElementById('btnCancel');
const btnConfirm = document.getElementById('btnConfirm');
const btnRefreshHistory = document.getElementById('btnRefreshHistory');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statToday = document.getElementById('statToday');
const statTotal = document.getElementById('statTotal');
const statPillToday = document.getElementById('statPillToday');
const statPillTotal = document.getElementById('statPillTotal');
const loaderText = document.getElementById('loaderText');
const queuePill = document.getElementById('queuePill');
const queuePillText = document.getElementById('queuePillText');

// ──────────────────────────────────────────────
//  INITIALIZATION
// ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Check for auth errors in URL (from failed OAuth callback)
  const params = new URLSearchParams(window.location.search);
  const authErr = params.get('auth_error');
  if (authErr) {
    showAuthError(authErr);
    // Clean the URL
    window.history.replaceState({}, '', '/');
  }

  // Check authentication status
  await checkAuth();

  // Event listeners
  btnSwitch.addEventListener('click', onSwitchClicked);
  btnCancel.addEventListener('click', closeModal);
  btnConfirm.addEventListener('click', executeSwitchNumber);
  btnRefreshHistory.addEventListener('click', loadHistory);
  btnLogout.addEventListener('click', logout);

  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
});

// ──────────────────────────────────────────────
//  AUTH CHECK
// ──────────────────────────────────────────────

async function checkAuth() {
  showState('loading');

  try {
    const resp = await fetch(`${API_BASE}/api/auth/me`, {
      credentials: 'same-origin',
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.success) {
        agentInfo = data.data;
        await onAuthenticated();
        return;
      }
    }
  } catch (error) {
    console.error('Auth check failed:', error);
  }

  // Not authenticated
  showState('login');
  setStatus('disconnected', 'Not logged in');
}

async function onAuthenticated() {
  // Update UI with agent info
  userName.textContent = agentInfo.extensionName;
  userExt.textContent = `Ext. ${agentInfo.extensionNumber}`;
  userAvatar.textContent = getInitials(agentInfo.extensionName);

  showState('authenticated');

  try {
    await Promise.all([loadMyNumber(), loadHistory()]);
    setStatus('connected', `${agentInfo.extensionName}`);

    // Restore cooldown timer & SMS panel if active
    await restoreCooldownAndSms();
  } catch (error) {
    console.error('Failed to load agent data:', error);
    setStatus('error', 'Error loading data');
  }
}

/**
 * Restore cooldown timer and SMS panel state on page load/refresh.
 * Called after authentication to ensure persistent UI state.
 */
async function restoreCooldownAndSms() {
  try {
    const { data } = await apiCall('GET', '/api/cooldown-status');
    if (data.active && data.cooldownRemainingSec > 0) {
      // Restore the cooldown timer on the switch button
      startCooldownTimer(data.cooldownRemainingSec);
    }

    // Show SMS panel if there was a recent switch (cooldown active or recently expired)
    // The panel should be visible as long as the agent has a number to manage
    if (data.active || data.hadRecentSwitch) {
      showSmsPanel();
    }
  } catch (err) {
    // Silently ignore — cooldown check is non-critical
    console.warn('Cooldown check failed:', err.message);
  }
}

/**
 * Show the SMS panel in the result area (for restore on refresh).
 */
function showSmsPanel() {
  resultContent.innerHTML = `
    <div class="sms-panel" id="smsPanel">
      <div class="sms-panel-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>SMS Messaging</span>
      </div>
      <div class="sms-panel-body" id="smsPanelBody">
        <p class="sms-hint">Checking SMS status for your number...</p>
      </div>
    </div>
  `;
  resultArea.style.display = 'block';

  // Automatically check SMS status
  checkSmsStatus();
}

async function logout() {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch (_) {}

  agentInfo = null;
  currentDirectNumber = null;
  inventoryNumbers = [];
  showState('login');
  setStatus('disconnected', 'Not logged in');
  statPillToday.style.display = 'none';
  statPillTotal.style.display = 'none';
}

// ──────────────────────────────────────────────
//  API CALLS
// ──────────────────────────────────────────────

async function apiCall(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${API_BASE}${path}`, opts);

  // Handle 401 — session expired
  if (resp.status === 401) {
    agentInfo = null;
    showState('login');
    setStatus('disconnected', 'Session expired');
    throw new Error('Session expired. Please log in again.');
  }

  const data = await resp.json();

  // Handle 429 cooldown response
  if (resp.status === 429 && data.error === 'cooldown') {
    const err = new Error(data.message);
    err.cooldown = true;
    err.cooldownRemainingSec = data.cooldownRemainingSec;
    throw err;
  }

  if (!resp.ok || !data.success) {
    throw new Error(data.details || data.error || 'API request failed');
  }

  return data;
}

// ──────────────────────────────────────────────
//  LOAD MY DATA
// ──────────────────────────────────────────────

async function loadMyNumber() {
  try {
    const [numbersResp, invResp] = await Promise.all([
      apiCall('GET', '/api/my-number'),
      apiCall('GET', '/api/inventory'),
    ]);

    currentDirectNumber = numbersResp.data.directNumber;
    if (currentDirectNumber) {
      currentNumberValue.textContent = formatPhone(currentDirectNumber.phoneNumber);
      currentNumberMeta.textContent = `ID: ${currentDirectNumber.id} • ${currentDirectNumber.usageType}`;
      currentNumberDisplay.style.display = 'block';
    } else {
      currentNumberValue.textContent = 'No Direct Number Found';
      currentNumberMeta.textContent = 'You may not have a Softphone number assigned';
      currentNumberDisplay.style.display = 'block';
    }

    inventoryNumbers = invResp.data;
    inventoryCount.textContent = inventoryNumbers.length;
    inventoryInfo.style.display = 'flex';

    btnSwitch.disabled = !currentDirectNumber || inventoryNumbers.length === 0;
  } catch (error) {
    console.error('Error loading agent data:', error);
    currentNumberValue.textContent = 'Error';
    currentNumberMeta.textContent = error.message;
    currentNumberDisplay.style.display = 'block';
  }
}

async function loadHistory() {
  try {
    const { data, stats } = await apiCall('GET', '/api/history?limit=50');

    statToday.textContent = stats.todayChanges;
    statTotal.textContent = stats.totalChanges;
    statPillToday.style.display = '';
    statPillTotal.style.display = '';

    if (data.length === 0) {
      historyList.innerHTML = `
        <div class="history-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          <p>No changes recorded yet</p>
          <span>Changes will appear here after the first switch</span>
        </div>
      `;
      return;
    }

    historyList.innerHTML = data
      .map((entry) => {
        const isSuccess = entry.status === 'success';
        const time = formatTime(entry.created_at);

        if (isSuccess) {
          return `
            <div class="history-item">
              <div class="history-icon-wrap success">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>
              <div class="history-details">
                <div class="history-numbers">
                  ${formatPhone(entry.old_phone_number)}
                  <span class="arrow">→</span>
                  ${formatPhone(entry.new_phone_number)}
                </div>
                <div class="history-time">${time}</div>
              </div>
            </div>
          `;
        } else {
          return `
            <div class="history-item">
              <div class="history-icon-wrap error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </div>
              <div class="history-details">
                <div class="history-error-msg">${escapeHtml(entry.error_message || 'Unknown error')}</div>
                <div class="history-time">${time}</div>
              </div>
            </div>
          `;
        }
      })
      .join('');
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

// ──────────────────────────────────────────────
//  EVENT HANDLERS
// ──────────────────────────────────────────────

function onSwitchClicked() {
  if (!agentInfo || !currentDirectNumber) return;

  confirmDetails.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Agent</span>
      <span class="detail-value">${escapeHtml(agentInfo.extensionName)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Extension</span>
      <span class="detail-value">${escapeHtml(agentInfo.extensionNumber)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Current Number</span>
      <span class="detail-value">${formatPhone(currentDirectNumber.phoneNumber)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">New Number</span>
      <span class="detail-value" style="color: var(--accent-secondary)">Random from inventory (${inventoryNumbers.length} available)</span>
    </div>
  `;
  confirmModal.style.display = 'flex';
}

function closeModal() {
  confirmModal.style.display = 'none';
}

// ──────────────────────────────────────────────
//  SWITCH EXECUTION (with Job Polling)
// ──────────────────────────────────────────────

async function executeSwitchNumber() {
  closeModal();

  // Show loading state
  const btnText = btnSwitch.querySelector('.btn-text');
  const btnIcon = btnSwitch.querySelector('.btn-icon');
  const btnLoader = btnSwitch.querySelector('.btn-loader');
  btnText.style.display = 'none';
  btnIcon.style.display = 'none';
  btnLoader.style.display = 'flex';
  btnSwitch.disabled = true;
  resultArea.style.display = 'none';
  loaderText.textContent = 'Queuing...';

  try {
    // Enqueue the job — NO extensionId in the body!
    // The backend reads it from the signed JWT cookie.
    const { data } = await apiCall('POST', '/api/switch-number', {});

    activeJobId = data.jobId;

    if (data.position > 1) {
      loaderText.textContent = `Queued (position ${data.position})...`;
    } else {
      loaderText.textContent = 'Processing...';
    }

    updateQueuePill(data.queueInfo);

    // Poll for result
    const result = await pollJobUntilDone(data.jobId);

    if (result.status === 'completed' && result.result) {
      showSuccessResult(result.result);
      currentNumberValue.textContent = formatPhone(result.result.newNumber);
      currentNumberMeta.textContent = 'Just updated';
      await loadHistory();
      // Start cooldown countdown after successful switch
      startCooldownTimer(10 * 60);
    } else if (result.status === 'failed') {
      showErrorResult(result.error || 'Unknown error');
      await loadHistory();
    }

  } catch (error) {
    // Handle cooldown rejection from backend
    if (error.cooldown) {
      startCooldownTimer(error.cooldownRemainingSec);
      showCooldownResult(error.cooldownRemainingSec);
    } else {
      showErrorResult(error.message);
    }
    try { await loadHistory(); } catch (_) {}
  } finally {
    activeJobId = null;
    stopPolling();
    btnText.style.display = 'inline';
    btnIcon.style.display = 'block';
    btnLoader.style.display = 'none';
    // Don't re-enable if cooldown is active
    if (!cooldownTimer) {
      btnSwitch.disabled = false;
    }
    loaderText.textContent = 'Processing...';
    updateQueuePill(null);
  }
}

/**
 * Poll GET /api/jobs/:id every 2s until completed or failed.
 */
function pollJobUntilDone(jobId) {
  return new Promise((resolve, reject) => {
    const POLL_INTERVAL = 2000;
    let attempts = 0;
    const MAX_ATTEMPTS = 150; // 5 minutes max

    async function poll() {
      attempts++;
      if (attempts > MAX_ATTEMPTS) {
        reject(new Error('Job timed out after 5 minutes'));
        return;
      }

      try {
        const { data } = await apiCall('GET', `/api/jobs/${jobId}`);

        if (data.status === 'queued') {
          loaderText.textContent = data.position > 0
            ? `Queued (position ${data.position})...`
            : 'Queued...';
          updateQueuePill(data.queueInfo);

        } else if (data.status === 'processing') {
          loaderText.textContent = 'Switching number...';

        } else if (data.status === 'completed') {
          resolve(data);
          return;

        } else if (data.status === 'failed') {
          resolve(data);
          return;
        }

        pollTimer = setTimeout(poll, POLL_INTERVAL);

      } catch (error) {
        if (attempts < MAX_ATTEMPTS) {
          pollTimer = setTimeout(poll, POLL_INTERVAL * 2);
        } else {
          reject(error);
        }
      }
    }

    poll();
  });
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ──────────────────────────────────────────────
//  RESULT DISPLAY
// ──────────────────────────────────────────────

function showSuccessResult(result) {
  const deletionBadge = result.oldNumberDeleted
    ? `<div class="deletion-badge success">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
           <polyline points="20 6 9 17 4 12"></polyline>
         </svg>
         Old number permanently deleted
       </div>`
    : `<div class="deletion-badge warning">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
           <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
           <line x1="12" y1="9" x2="12" y2="13"></line>
           <line x1="12" y1="17" x2="12.01" y2="17"></line>
         </svg>
         Old number may still be in inventory
       </div>`;

  resultContent.innerHTML = `
    <div class="result-success">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="result-icon">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <div class="result-text">
        <h4>Number Switched Successfully!</h4>
        <p>${escapeHtml(result.message)}</p>
      </div>
    </div>
    <div class="number-swap-display">
      <span class="old-num">${formatPhone(result.oldNumber)}</span>
      <span class="arrow">→</span>
      <span class="new-num">${formatPhone(result.newNumber)}</span>
    </div>
    ${deletionBadge}
    <div class="sms-panel" id="smsPanel">
      <div class="sms-panel-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>SMS Messaging</span>
      </div>
      <div class="sms-panel-body" id="smsPanelBody">
        <p class="sms-hint">Would you like to activate SMS for this new number?</p>
        <div class="sms-actions">
          <button class="sms-btn activate" onclick="activateSms()" id="btnActivateSms">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            Activate SMS
          </button>
          <button class="sms-btn check" onclick="checkSmsStatus()" id="btnCheckSms">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            Check Status
          </button>
        </div>
        <p class="sms-note">⚠️ Activation may take up to 48 hours. Immediate results can happen, but are not guaranteed — please be patient.</p>
      </div>
    </div>
  `;
  resultArea.style.display = 'block';
}

function showErrorResult(message) {
  // Detect specific RingCentral error codes for user-friendly messages
  const isRcApiError = message && (message.includes('CMN-203') || message.includes('CMN-201'));

  let errorTitle = 'Switch Failed';
  let errorBody = '';

  if (isRcApiError) {
    errorTitle = 'RingCentral API Error';
    errorBody = 'The RingCentral API is currently failing. Please contact an administrator for your number change.';
  } else {
    // Extract the error code/name if present (e.g., "CMN-xxx" or other identifiers)
    const codeMatch = message && message.match(/\b(CMN-\d+|[A-Z]{2,5}-\d{3,})\b/);
    const errorName = codeMatch ? codeMatch[1] : null;

    if (errorName) {
      errorBody = `An error has occurred (${errorName}). Please contact an administrator for your number change.`;
    } else {
      errorBody = 'An error has occurred. Please contact an administrator for your number change.';
    }
  }

  resultContent.innerHTML = `
    <div class="result-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="result-icon">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>
      <div class="result-text">
        <h4>${errorTitle}</h4>
        <p>${escapeHtml(errorBody)}</p>
      </div>
    </div>
  `;
  resultArea.style.display = 'block';
}

// ──────────────────────────────────────────────
//  SMS ACTIVATION
// ──────────────────────────────────────────────

/**
 * Request SMS activation for the agent's current number.
 * Calls POST /api/sms-activation to link the number to the TCR campaign.
 */
async function activateSms() {
  const btn = document.getElementById('btnActivateSms');
  const body = document.getElementById('smsPanelBody');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const { data } = await apiCall('POST', '/api/sms-activation');

    body.innerHTML = `
      <div class="sms-status-result pending">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <div>
          <strong>Request Sent</strong>
          <p>${escapeHtml(data.message)}</p>
          <p class="sms-phone">${formatPhone(data.phoneNumber)}</p>
        </div>
      </div>
      <button class="sms-btn check" onclick="checkSmsStatus()" style="margin-top:8px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        Check Status
      </button>
    `;
  } catch (error) {
    body.innerHTML = `
      <div class="sms-status-result error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
        <div>
          <strong>SMS Activation Error</strong>
          <p>${escapeHtml(error.message)}</p>
        </div>
      </div>
    `;
  }
}

/**
 * Check the current SMS status for the agent's phone number.
 * Calls GET /api/sms-status.
 */
async function checkSmsStatus() {
  const body = document.getElementById('smsPanelBody');
  if (!body) return;

  body.innerHTML = '<p class="sms-hint">Checking SMS status...</p>';

  try {
    const { data } = await apiCall('GET', '/api/sms-status');

    if (data.smsEnabled) {
      const campaign = data.campaign;
      const useCases = campaign?.useCases?.join(', ') || 'N/A';
      body.innerHTML = `
        <div class="sms-status-result confirmed">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <div>
            <strong>SMS Active</strong>
            <p>${formatPhone(data.phoneNumber)}</p>
            ${campaign ? `<p class="sms-detail">Campaign: ${campaign.status} | Tier: ${campaign.registrationTier || 'N/A'}</p>
            <p class="sms-detail">Uses: ${useCases}</p>` : ''}
          </div>
        </div>
      `;
    } else if (data.campaignStatus) {
      body.innerHTML = `
        <div class="sms-status-result pending">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <div>
            <strong>SMS Pending</strong>
            <p>${formatPhone(data.phoneNumber)} — Status: ${data.campaignStatus}</p>
            <p class="sms-note">⚠️ Activation may take up to 48 hours. Immediate results can happen, but are not guaranteed — please be patient.</p>
          </div>
        </div>
        <button class="sms-btn check" onclick="checkSmsStatus()" style="margin-top:8px">
          🔄 Check Again
        </button>
      `;
    } else {
      body.innerHTML = `
        <div class="sms-status-result inactive">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
          </svg>
          <div>
            <strong>SMS Not Configured</strong>
            <p>${formatPhone(data.phoneNumber || '')} — No campaign assigned</p>
          </div>
        </div>
        <div class="sms-actions" style="margin-top:8px">
          <button class="sms-btn activate" onclick="activateSms()" id="btnActivateSms">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            Activate SMS
          </button>
          <button class="sms-btn check" onclick="checkSmsStatus()" id="btnCheckSms">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            Check Status
          </button>
        </div>
        <p class="sms-note">⚠️ Activation may take up to 48 hours. Immediate results can happen, but are not guaranteed — please be patient.</p>
      `;
    }
  } catch (error) {
    body.innerHTML = `
      <div class="sms-status-result error">
        <strong>Error</strong>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  }
}

// ──────────────────────────────────────────────
//  COOLDOWN TIMER
// ──────────────────────────────────────────────

/**
 * Start a visual countdown on the switch button.
 * Disables the button until the cooldown expires.
 */
function startCooldownTimer(seconds) {
  // Clear any existing timer
  if (cooldownTimer) clearInterval(cooldownTimer);

  let remaining = seconds;
  const btnText = btnSwitch.querySelector('.btn-text');
  btnSwitch.disabled = true;
  btnSwitch.classList.add('cooldown');

  function updateDisplay() {
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    btnText.textContent = `Wait ${min}:${sec.toString().padStart(2, '0')}`;
  }

  updateDisplay();

  cooldownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      btnText.textContent = 'Switch My Number';
      btnSwitch.disabled = false;
      btnSwitch.classList.remove('cooldown');
    } else {
      updateDisplay();
    }
  }, 1000);
}

/**
 * Show a cooldown warning in the result area.
 */
function showCooldownResult(seconds) {
  const min = Math.ceil(seconds / 60);
  resultContent.innerHTML = `
    <div class="result-cooldown">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="result-icon">
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
      <div class="result-text">
        <h4>Cooldown Active</h4>
        <p>You must wait ${min} minute(s) between number changes to prevent abuse.</p>
      </div>
    </div>
  `;
  resultArea.style.display = 'block';
}

// ──────────────────────────────────────────────
//  UI STATE MANAGEMENT
// ──────────────────────────────────────────────

function showState(state) {
  stateLoading.style.display = state === 'loading' ? '' : 'none';
  stateLogin.style.display = state === 'login' ? '' : 'none';
  stateAuthenticated.style.display = state === 'authenticated' ? '' : 'none';
  historyCard.style.display = state === 'authenticated' ? '' : 'none';
}

function showAuthError(message) {
  authError.style.display = 'flex';
  authErrorText.textContent = message;
}

// ──────────────────────────────────────────────
//  QUEUE UI HELPERS
// ──────────────────────────────────────────────

function updateQueuePill(queueInfo) {
  if (!queueInfo || queueInfo.pendingJobs === 0) {
    queuePill.style.display = 'none';
    return;
  }
  queuePill.style.display = 'flex';

  if (queueInfo.isPaused) {
    queuePillText.textContent = `Cooldown: ${queueInfo.pauseRemainingSec}s`;
    queuePill.classList.add('paused');
  } else {
    queuePillText.textContent = `Queue: ${queueInfo.pendingJobs}`;
    queuePill.classList.remove('paused');
  }
}

// ──────────────────────────────────────────────
//  UTILITIES
// ──────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state === 'connected') statusDot.classList.add('connected');
  else if (state === 'error') statusDot.classList.add('error');
  statusText.textContent = text;
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return parts[0].substring(0, 2).toUpperCase();
}

function formatPhone(phone) {
  if (!phone) return '—';
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `(${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  }
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
