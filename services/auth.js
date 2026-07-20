// ============================================================
// Auth Service — RingCentral OAuth + JWT Session Management
//
// Architecture:
//   - App 2 (OAuth, Auth Code Flow) is used ONLY to authenticate
//     agents and read their extension identity via extension/~.
//   - App 1 (JWT admin) continues to handle all heavy API operations.
//   - The agent's OAuth access_token is DISCARDED after identity
//     resolution. A signed JWT session cookie is issued instead.
// ============================================================
require('dotenv').config();
const { SDK } = require('@ringcentral/sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_TTL = '8h'; // One work shift

// ── In-memory CSRF state store (state → timestamp) ──
// States expire after 5 minutes
const pendingStates = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;

/**
 * Create a fresh RC SDK instance for the OAuth app (App 2).
 * Each call gets its own instance because the SDK's platform
 * object is stateful and we can't share it across users.
 */
function _createOAuthSDK() {
  return new SDK({
    server: process.env.RC_SERVER_URL,
    clientId: process.env.RC_OAUTH_CLIENT_ID,
    clientSecret: process.env.RC_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.RC_REDIRECT_URI,
  });
}

/**
 * Generate the RingCentral OAuth login URL.
 * Includes a random `state` parameter for CSRF prevention.
 * @returns {{ url: string, state: string }}
 */
function getLoginUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());

  // Prune expired states
  const now = Date.now();
  for (const [s, ts] of pendingStates.entries()) {
    if (now - ts > STATE_TTL_MS) pendingStates.delete(s);
  }

  const sdk = _createOAuthSDK();
  const platform = sdk.platform();
  const url = platform.loginUrl({ state });

  console.log('[Auth] 🔗 Login URL generated');
  console.log('[Auth] 🔍 DEBUG redirect_uri from env:', process.env.RC_REDIRECT_URI);
  console.log('[Auth] 🔍 DEBUG full login URL:', url);
  return { url, state };
}

/**
 * Validate a returned state parameter.
 * @param {string} state
 * @returns {boolean}
 */
function validateState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const ts = pendingStates.get(state);
  pendingStates.delete(state);
  return (Date.now() - ts) < STATE_TTL_MS;
}

/**
 * Exchange an authorization code for the agent's identity.
 *
 * Flow:
 * 1. Use App 2 SDK to exchange code for agent's access_token
 * 2. Call GET /restapi/v1.0/account/~/extension/~ with that token
 * 3. Extract { extensionId, name, extensionNumber }
 * 4. Discard the access_token (we only needed it for identity)
 *
 * @param {string} code — The authorization code from RC callback
 * @returns {Promise<{ extensionId: string, extensionName: string, extensionNumber: string }>}
 */
async function handleCallback(code) {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 3000; // 3 seconds

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sdk = _createOAuthSDK();
      const platform = sdk.platform();

      // Step 1: Exchange code for access token
      console.log(`[Auth] 🔄 Exchanging authorization code for token (attempt ${attempt}/${MAX_RETRIES})...`);
      console.log('[Auth] 🔍 DEBUG token exchange redirect_uri:', process.env.RC_REDIRECT_URI);
      await platform.login({ code, redirect_uri: process.env.RC_REDIRECT_URI });
      console.log('[Auth] ✅ Agent token obtained');

      // Step 2: Use the agent's token to read their own extension info
      console.log('[Auth] 👤 Reading agent identity via extension/~...');
      const resp = await platform.get('/restapi/v1.0/account/~/extension/~');
      const extInfo = await resp.json();

      const agentInfo = {
        extensionId: String(extInfo.id),
        extensionName: extInfo.name || `Ext ${extInfo.extensionNumber}`,
        extensionNumber: extInfo.extensionNumber || '',
      };

      console.log(`[Auth] ✅ Agent identified: ${agentInfo.extensionName} (ID: ${agentInfo.extensionId}, Ext: ${agentInfo.extensionNumber})`);

      // Step 3: Logout from the agent's SDK session (discard token)
      try { await platform.logout(); } catch (_) {}

      return agentInfo;

    } catch (err) {
      // Check if it's a rate limit (429) error
      const statusCode = err.response?.status || err.apiResponse?.status || null;
      const retryAfter = parseInt(err.response?.headers?.get('retry-after')) || null;
      const is429 = statusCode === 429 || (err.message && err.message.includes('429'));

      if (is429 && attempt < MAX_RETRIES) {
        // Use Retry-After header if available, otherwise exponential backoff
        const waitMs = retryAfter
          ? retryAfter * 1000
          : BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[Auth] ⚠️ Auth rate limited (429). Waiting ${waitMs / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      // Non-retryable error or max retries exhausted
      console.error(`[Auth] ❌ Login failed (attempt ${attempt}): ${err.message}`);
      throw err;
    }
  }
}

/**
 * Create a signed JWT session token for the authenticated agent.
 * This token is stored in an HttpOnly cookie and contains the
 * agent's verified identity that CANNOT be tampered with.
 *
 * @param {{ extensionId: string, extensionName: string, extensionNumber: string }} agentInfo
 * @returns {string} Signed JWT
 */
function createSessionToken(agentInfo) {
  const token = jwt.sign(
    {
      extensionId: agentInfo.extensionId,
      extensionName: agentInfo.extensionName,
      extensionNumber: agentInfo.extensionNumber,
    },
    SESSION_SECRET,
    { expiresIn: SESSION_TTL }
  );

  console.log(`[Auth] 🔑 Session token created for ${agentInfo.extensionName} (expires in ${SESSION_TTL})`);
  return token;
}

/**
 * Verify and decode a JWT session token.
 * @param {string} token
 * @returns {{ extensionId: string, extensionName: string, extensionNumber: string }}
 * @throws {Error} If token is invalid or expired
 */
function verifySessionToken(token) {
  return jwt.verify(token, SESSION_SECRET);
}

module.exports = {
  getLoginUrl,
  validateState,
  handleCallback,
  createSessionToken,
  verifySessionToken,
};
