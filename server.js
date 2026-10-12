require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const mpesa = require('./mpesa');
const { formatPhoneNumber, maskPhone } = require('./phone');
const { runPasswordTests } = require('./test');
const { getPrisma, disconnect } = require('./db');
const callbacks = require('./callback');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Task 2: health check
app.get('/api/health', (req, res) => {
  try {
    const config = mpesa.validateConfig();
    res.json({
      status: 'ok',
      mpesa_configured: true,
      environment: config.env,
      shortcode: config.shortcode,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      mpesa_configured: false,
      error: err.message,
    });
  }
});

// Task 1: token + cache demo
app.get('/api/mpesa/token', async (req, res) => {
  const start = process.hrtime.bigint();
  try {
    const token = await mpesa.getAccessToken();
    const elapsedMs = Number((process.hrtime.bigint() - start) / 1000n);
    const fromCache = mpesa.getLastTokenSource() === 'cache';
    res.json({
      success: true,
      token_preview: `${token.substring(0, 20)}...`,
      fetch_time_ms: Math.round(elapsedMs) / 1000,
      message: fromCache
        ? 'Token returned from cache (fast)'
        : 'Token fetched from Daraja (network request)',
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Task 3: timestamp/password test
app.get('/api/mpesa/test-password', (req, res) => {
  try {
    const timestamp = mpesa.getTimestamp();
    const password = mpesa.generatePassword(timestamp);
    const tests = runPasswordTests();
    res.json({
      timestamp,
      password_preview: `${password.substring(0, 20)}...`,
      password_length: password.length,
      tests_passed: tests.passed,
      tests: tests.results,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bonus: Daraja connectivity health
app.get('/api/mpesa/health', async (req, res) => {
  const result = await mpesa.checkDarajaHealth();
  res.status(result.reachable ? 200 : 503).json(result);
});

// Day 2: STK Push endpoint, in-memory transactions, masked logging

// Payments live in PostgreSQL (Prisma). The request log stays in memory (reset on restart);
// it is exposed via app.locals so tests can inspect it.
app.locals.logs = [];
const MAX_LOG_ENTRIES = 1000;
const LOGS_RETURNED = 20;

const pad2 = (n) => String(n).padStart(2, '0');
function formatLocalTime(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Logs one STK Push attempt to the console and the in-memory log. Phone numbers are masked. */
function logSTKPush({ phone, amount, status, checkoutRequestId, error }) {
  const now = new Date();
  // Only echo amounts that are really numbers, so user input can't forge log lines.
  const isNumeric =
    (typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '')) &&
    Number.isFinite(Number(amount));
  const loggedAmount = isNumeric ? Number(amount) : null;
  const masked = maskPhone(phone);

  const entry = {
    timestamp: now.toISOString(),
    phone: masked,
    amount: loggedAmount,
    status,
    ...(checkoutRequestId ? { checkoutRequestId } : {}),
    ...(error ? { error } : {}),
  };
  app.locals.logs.push(entry);
  if (app.locals.logs.length > MAX_LOG_ENTRIES) {
    app.locals.logs.splice(0, app.locals.logs.length - MAX_LOG_ENTRIES);
  }

  const detail = status === 'SUCCESS' ? checkoutRequestId : error;
  console.log(
    `[${formatLocalTime(now)}] STK Push | ${masked} | KES ${loggedAmount === null ? 'N/A' : loggedAmount} | ${status} | ${detail}`
  );
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { phoneNumber, amount, accountReference = 'Payment', transactionDesc = 'Payment' } = body;

  let phoneForLog = phoneNumber;
  try {
    const phone = formatPhoneNumber(phoneNumber);
    if (!phone.success) throw new mpesa.MpesaError(phone.error, 400);
    phoneForLog = phone.formatted;

    const validAmount = mpesa.validateAmount(amount);

    const result = await mpesa.initiateSTKPush(
      phone.formatted,
      validAmount,
      accountReference,
      transactionDesc
    );

    // Persist as "pending" so the callback (and the query endpoint) have a record to update.
    let payment;
    try {
      payment = await getPrisma().payment.create({
        data: {
          checkoutRequestId: result.CheckoutRequestID,
          merchantRequestId: result.MerchantRequestID ?? null,
          phoneNumber: phone.formatted,
          amount: validAmount,
          accountReference: String(accountReference).trim(),
          transactionDesc: String(transactionDesc).trim(),
          status: 'pending',
        },
      });
    } catch (dbErr) {
      // The customer has already been prompted, so keep the reference for manual reconciliation.
      console.error(
        `Failed to save payment ${result.CheckoutRequestID} after a successful STK Push: ${dbErr.message}`
      );
      throw new mpesa.MpesaError(
        `STK Push was sent but the payment could not be saved. Reference: ${result.CheckoutRequestID}`,
        500
      );
    }

    logSTKPush({
      phone: phone.formatted,
      amount: validAmount,
      status: 'SUCCESS',
      checkoutRequestId: result.CheckoutRequestID,
    });

    res.json({
      success: true,
      message: 'STK Push sent. Check your phone for the M-Pesa prompt.',
      data: { paymentId: payment.id, checkoutRequestId: payment.checkoutRequestId },
    });
  } catch (err) {
    const known = err instanceof mpesa.MpesaError;
    const status = known ? err.status : 500;
    const message = known ? err.message : 'Internal server error';
    if (!known) console.error(err);

    logSTKPush({ phone: phoneForLog, amount, status: 'FAILED', error: message });
    res.status(status).json({ success: false, error: message });
  }
});

// Bonus: last 20 log entries (oldest first)
app.get('/api/mpesa/logs', (req, res) => {
  const logs = app.locals.logs.slice(-LOGS_RETURNED);
  res.json({ success: true, count: logs.length, logs });
});

// Day 3: callback, query, and simulator
const CALLBACK_ACK = { ResultCode: 0, ResultDesc: 'Accepted' };
const PENDING_MESSAGE = 'Payment is still being processed. Try again in a few seconds.';

/** The shape returned to clients for a payment that has a final result. */
function resolvedData(payment) {
  return {
    status: payment.status,
    resultCode: payment.resultCode,
    resultDesc: payment.resultDesc,
    mpesaReceiptNumber: payment.mpesaReceiptNumber,
    amount: payment.amount,
    phoneNumber: payment.phoneNumber,
  };
}

// Task 1 + 2: Daraja posts here. Always acknowledge with 200 FIRST (a non-200 makes Safaricom
// retry and can cause duplicate processing), then process in the background.
app.post('/api/mpesa/callback', (req, res) => {
  res.status(200).json(CALLBACK_ACK);
  callbacks.handleCallbackInBackground(req.body);
});

// Task 3: payment status (local DB first, Daraja only if still pending)
app.post('/api/mpesa/query', async (req, res) => {
  const raw = req.body && typeof req.body === 'object' ? req.body.checkoutRequestId : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return res.status(400).json({ success: false, error: 'checkoutRequestId is required.' });
  }
  const checkoutRequestId = raw.trim();
  const prisma = getPrisma();

  try {
    let payment = await prisma.payment.findUnique({ where: { checkoutRequestId } });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }
    if (payment.status !== 'pending') {
      return res.json({ success: true, data: resolvedData(payment) });
    }

    // Still pending: ask Daraja. Any failure here just means "status unknown, try again".
    let query;
    try {
      query = await mpesa.querySTKStatus(checkoutRequestId);
    } catch (err) {
      console.warn(`Status query for ${checkoutRequestId.slice(0, 60)} failed: ${err.message}`);
      return res.json({ success: true, data: { status: 'pending', message: PENDING_MESSAGE } });
    }

    const resultCode = callbacks.parseResultCode(query && query.ResultCode);
    if (resultCode === null) {
      return res.json({ success: true, data: { status: 'pending', message: PENDING_MESSAGE } });
    }

    const status = callbacks.statusFromResultCode(resultCode);
    const resultDesc = typeof query.ResultDesc === 'string' ? query.ResultDesc : null;

    // Guarded update: if a callback resolved the payment while we were asking Daraja,
    // this changes nothing and we return what the callback stored.
    await prisma.payment.updateMany({
      where: { checkoutRequestId, status: 'pending' },
      data: { status, resultCode, resultDesc },
    });
    payment = await prisma.payment.findUnique({ where: { checkoutRequestId } });
    return res.json({ success: true, data: resolvedData(payment) });
  } catch (err) {
    console.error(`Query error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Bonus: simulate Daraja's callback so the whole flow works without ngrok or the sandbox
app.post('/api/mpesa/simulate-callback', async (req, res) => {
  if (String(process.env.MPESA_ENV || '').trim().toLowerCase() === 'production') {
    return res.status(403).json({ success: false, error: 'Callback simulation is disabled in production.' });
  }

  const { checkoutRequestId, success } = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof checkoutRequestId !== 'string' || checkoutRequestId.trim() === '') {
    return res.status(400).json({ success: false, error: 'checkoutRequestId is required.' });
  }
  if (typeof success !== 'boolean') {
    return res.status(400).json({ success: false, error: 'success must be true or false.' });
  }

  try {
    const prisma = getPrisma();
    const id = checkoutRequestId.trim();
    const payment = await prisma.payment.findUnique({ where: { checkoutRequestId: id } });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    const payload = callbacks.buildSimulatedCallback(payment, success, mpesa.getTimestamp());

    // Send it through the real HTTP endpoint, exactly like Daraja would. The target is always
    // our own loopback port, never taken from request headers.
    const port = req.socket.localPort;
    const ack = await fetch(`http://127.0.0.1:${port}/api/mpesa/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!ack.ok) {
      return res.status(502).json({ success: false, error: `Callback endpoint answered HTTP ${ack.status}` });
    }

    // The endpoint acknowledges before processing, so wait for the processing to finish.
    await callbacks.whenIdle();
    const updated = await prisma.payment.findUnique({ where: { checkoutRequestId: id } });

    const stk = payload.Body.stkCallback;
    res.json({
      success: true,
      message: success ? 'Simulated successful payment callback sent.' : 'Simulated cancelled payment callback sent.',
      simulated: {
        resultCode: stk.ResultCode,
        resultDesc: stk.ResultDesc,
        mpesaReceiptNumber: success ? callbacks.getCallbackValue(stk.CallbackMetadata, 'MpesaReceiptNumber') : null,
      },
      data: resolvedData(updated),
    });
  } catch (err) {
    console.error(`Simulation error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Malformed JSON bodies and anything unexpected
app.use((err, req, res, next) => {
  // Daraja callbacks must always be acknowledged with 200, even when unusable.
  if (err.type === 'entity.parse.failed' && req.path === '/api/mpesa/callback') {
    console.warn('Callback ignored: body is not valid JSON');
    return res.status(200).json(CALLBACK_ACK);
  }
  if (err.type === 'entity.parse.failed') {
    // The body never reached the route handler, so log the failed STK attempt here.
    if (req.path === '/api/mpesa/stkpush') {
      logSTKPush({ status: 'FAILED', error: 'Invalid JSON in request body.' });
    }
    return res.status(400).json({ success: false, error: 'Invalid JSON in request body.' });
  }
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

if (require.main === module) {
  try {
    mpesa.validateConfig();
    getPrisma(); // fails fast if DATABASE_URL is missing
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

  const shutdown = () => {
    server.close(async () => {
      await disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
