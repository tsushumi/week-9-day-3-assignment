require('dotenv').config({ quiet: true });
const axios = require('axios');

const REQUIRED_VARS = [
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_SHORTCODE',
  'MPESA_PASSKEY',
  'MPESA_ENV',
];

// Task 2: configuration
let warnedProduction = false;

/**
 * Reads and validates all M-Pesa env vars. Throws if any are missing/empty.
 * Logs a warning when running in production.
 */
function validateConfig() {
  const missing = REQUIRED_VARS.filter((name) => {
    const value = process.env[name];
    return value === undefined || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new MpesaError(`Missing required environment variables: ${missing.join(', ')}`, 500);
  }

  const config = {
    consumerKey: process.env.MPESA_CONSUMER_KEY.trim(),
    consumerSecret: process.env.MPESA_CONSUMER_SECRET.trim(),
    shortcode: process.env.MPESA_SHORTCODE.trim(),
    passkey: process.env.MPESA_PASSKEY.trim(),
    env: process.env.MPESA_ENV.trim().toLowerCase(),
  };

  // Warn once per process; validateConfig() runs on every request.
  if (config.env === 'production' && !warnedProduction) {
    warnedProduction = true;
    console.warn('WARNING: Running in PRODUCTION mode');
  }

  return config;
}

function getBaseUrl() {
  const env = String(process.env.MPESA_ENV || '').trim().toLowerCase();
  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function getBase64Credentials() {
  const { consumerKey, consumerSecret } = validateConfig();
  return Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
}

// Task 1: OAuth with caching
let cachedToken = null;
let tokenExpiry = 0; // epoch ms
let lastTokenSource = 'network'; // 'network' | 'cache'

const EXPIRY_BUFFER_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
}

function getLastTokenSource() {
  return lastTokenSource;
}

/**
 * Error carrying an HTTP status the Express layer can use:
 * 400 = caller's fault (validation), 502 = Daraja/network problem, 500 = our config.
 */
class MpesaError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'MpesaError';
    this.status = status;
  }
}

/** Turns an axios failure into a descriptive MpesaError (502). */
function toDarajaError(err, label) {
  if (err instanceof MpesaError) return err;
  if (err.response) {
    const { status, data } = err.response;
    const detail =
      (data && (data.errorMessage || data.error_description || data.error)) ||
      (typeof data === 'string' && data) ||
      'No details provided';
    return new MpesaError(`${label} (HTTP ${status}): ${detail}`, 502);
  }
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return new MpesaError('Network error: connection to Daraja timed out', 502);
  }
  if (err.request) {
    return new MpesaError(`Network error: unable to reach Daraja (${err.code || err.message})`, 502);
  }
  return err;
}

async function getAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiry) {
    lastTokenSource = 'cache';
    return cachedToken;
  }

  // Throws a descriptive error if credentials are missing
  const encoded = getBase64Credentials();
  const url = `${getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Basic ${encoded}` },
      timeout: REQUEST_TIMEOUT_MS,
    });

    const { access_token: token, expires_in: expiresIn } = response.data || {};
    if (!token) {
      clearTokenCache();
      throw new MpesaError('Daraja response did not contain an access_token', 502);
    }

    const ttlSeconds = Number(expiresIn) || 3599;
    cachedToken = token;
    tokenExpiry = Date.now() + ttlSeconds * 1000 - EXPIRY_BUFFER_MS;
    lastTokenSource = 'network';
    return cachedToken;
  } catch (err) {
    clearTokenCache();
    throw toDarajaError(err, 'Daraja authentication failed');
  }
}

// Task 3: timestamp and password
function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function generatePassword(timestamp) {
  if (!/^\d{14}$/.test(String(timestamp))) {
    throw new Error('Timestamp must be a 14-digit string in YYYYMMDDHHmmss format');
  }
  const { shortcode, passkey } = validateConfig();
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Day 2: STK Push
// ---------------------------------------------------------------------------

const { formatPhoneNumber } = require('./phone');

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 150000;
const AMOUNT_RANGE_ERROR = 'Amount must be between 1 and 150,000 KES';
const MAX_ACCOUNT_REFERENCE_LENGTH = 12; // Daraja limit
const MAX_TRANSACTION_DESC_LENGTH = 13; // Daraja limit

/** Returns the amount as an integer, or throws a 400 MpesaError. */
function validateAmount(amount) {
  if (amount === undefined || amount === null || (typeof amount === 'string' && amount.trim() === '')) {
    throw new MpesaError('Amount is required.', 400);
  }
  let value = amount;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MpesaError('Amount must be a number.', 400);
  }
  if (!Number.isInteger(value)) {
    throw new MpesaError('Amount must be a whole number of KES (no decimals).', 400);
  }
  if (value < MIN_AMOUNT || value > MAX_AMOUNT) {
    throw new MpesaError(AMOUNT_RANGE_ERROR, 400);
  }
  return value;
}

function validateText(label, value, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MpesaError(`${label} is required.`, 400);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new MpesaError(`${label} must be at most ${maxLength} characters.`, 400);
  }
  return trimmed;
}

function getCallbackUrl() {
  const url = String(process.env.MPESA_CALLBACK_URL || '').trim();
  if (!url) {
    throw new MpesaError('Missing required environment variable: MPESA_CALLBACK_URL', 500);
  }
  if (!/^https:\/\/\S+$/.test(url)) {
    throw new MpesaError('MPESA_CALLBACK_URL must be a public https:// URL', 500);
  }
  if (url.includes('your-ngrok-url')) {
    throw new MpesaError('MPESA_CALLBACK_URL is still the placeholder value; set your ngrok URL in .env', 500);
  }
  return url;
}

/**
 * Sends an STK Push (M-Pesa Express) prompt to the customer's phone.
 * Phone numbers may be in any supported Kenyan format; they are normalised to 254XXXXXXXXX.
 * Resolves with Daraja's response data (MerchantRequestID, CheckoutRequestID, ...).
 */
async function initiateSTKPush(phoneNumber, amount, accountReference, transactionDesc) {
  // 1. Validate inputs before spending a network call
  const phone = formatPhoneNumber(phoneNumber);
  if (!phone.success) throw new MpesaError(phone.error, 400);
  const validAmount = validateAmount(amount);
  const reference = validateText('Account reference', accountReference, MAX_ACCOUNT_REFERENCE_LENGTH);
  const description = validateText('Transaction description', transactionDesc, MAX_TRANSACTION_DESC_LENGTH);

  // 2. Configuration
  const { shortcode } = validateConfig();
  const callbackUrl = getCallbackUrl();

  // 3. Auth + password. The same timestamp must be used in the password and the payload.
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = generatePassword(timestamp);

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: validAmount,
    PartyA: phone.formatted,
    PartyB: shortcode,
    PhoneNumber: phone.formatted,
    CallBackURL: callbackUrl,
    AccountReference: reference,
    TransactionDesc: description,
  };

  // 4. Send
  let data;
  try {
    const response = await axios.post(`${getBaseUrl()}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response.data;
  } catch (err) {
    // A 401 means our cached token was rejected; make the next call fetch a fresh one.
    if (err.response && err.response.status === 401) clearTokenCache();
    throw toDarajaError(err, 'STK Push failed');
  }

  if (!data || String(data.ResponseCode) !== '0') {
    const reason = (data && (data.ResponseDescription || data.errorMessage)) || 'Unknown error';
    throw new MpesaError(`STK Push rejected by Daraja: ${reason}`, 502);
  }
  return data;
}

// Day 3: STK Push query
/**
 * Asks Daraja for the status of an STK Push. Resolves with the raw response
 * (ResponseCode, ResultCode, ResultDesc, ...). Throws an MpesaError if the call fails.
 * Note that while a payment is still being processed Daraja itself answers with an error,
 * so callers should treat a thrown error as "status unknown", not "failed".
 */
async function querySTKStatus(checkoutRequestId) {
  if (typeof checkoutRequestId !== 'string' || checkoutRequestId.trim() === '') {
    throw new MpesaError('checkoutRequestId is required.', 400);
  }
  const { shortcode } = validateConfig();
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const password = generatePassword(timestamp);

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId.trim(),
  };

  try {
    const response = await axios.post(`${getBaseUrl()}/mpesa/stkpushquery/v1/query`, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    return response.data;
  } catch (err) {
    if (err.response && err.response.status === 401) clearTokenCache();
    throw toDarajaError(err, 'STK Push query failed');
  }
}

// Bonus: Daraja health checker
async function checkDarajaHealth() {
  const start = Date.now();
  try {
    // Bypass the cache so we measure a real network round trip. A successful
    // check also refreshes the cache; a failed one clears it (see getAccessToken).
    await getAccessToken({ forceRefresh: true });
    return {
      reachable: true,
      response_time_ms: Date.now() - start,
      token_valid: true,
    };
  } catch (err) {
    const message = err.message || 'Unknown error';

    // The API answered (HTTP error such as 400/401): reachable, but token not valid
    if (/HTTP \d+/.test(message)) {
      return {
        reachable: true,
        response_time_ms: Date.now() - start,
        token_valid: false,
        error: message,
      };
    }
    // Config problems are not connectivity problems
    if (/Missing required environment variables/.test(message)) {
      return { reachable: false, response_time_ms: null, error: message };
    }
    return {
      reachable: false,
      response_time_ms: null,
      error: /timed out/i.test(message) ? 'Connection timed out' : message,
    };
  }
}

module.exports = {
  validateConfig,
  getBaseUrl,
  getBase64Credentials,
  getAccessToken,
  clearTokenCache,
  getLastTokenSource,
  getTimestamp,
  generatePassword,
  checkDarajaHealth,
  initiateSTKPush,
  querySTKStatus,
  validateAmount,
  getCallbackUrl,
  MpesaError,
};
