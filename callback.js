const crypto = require('crypto');
const { getPrisma } = require('./db');

const CANCELLED_BY_USER = 1032;
const RECEIPT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Helpers

/**
 * Searches CallbackMetadata.Item for an entry by Name and returns its Value,
 * or null if the metadata, the item, or the item's Value is missing.
 * (Some items, like "Balance", legitimately have no Value.)
 */
function getCallbackValue(metadata, name) {
  const items = metadata && Array.isArray(metadata.Item) ? metadata.Item : [];
  const item = items.find((i) => i && i.Name === name);
  return item && item.Value !== undefined && item.Value !== null ? item.Value : null;
}

/** Daraja sends ResultCode as a number in callbacks and as a string in query responses. */
function parseResultCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** 0 = completed, 1032 = cancelled by the user, anything else = failed. */
function statusFromResultCode(code) {
  const n = parseResultCode(code);
  if (n === 0) return 'completed';
  if (n === CANCELLED_BY_USER) return 'cancelled';
  return 'failed';
}

/** Callback bodies are untrusted: strip control characters and cap length before logging. */
function clean(value, max = 120) {
  return String(value).replace(/[^\x20-\x7E]/g, '?').slice(0, max);
}

/** Reads the fields that only exist on a successful callback. */
function extractSuccessDetails(metadata) {
  const amount = getCallbackValue(metadata, 'Amount');
  const receipt = getCallbackValue(metadata, 'MpesaReceiptNumber');
  const date = getCallbackValue(metadata, 'TransactionDate');
  const phone = getCallbackValue(metadata, 'PhoneNumber');

  const details = {};
  if (amount !== null && Number.isFinite(Number(amount))) details.amount = Number(amount);
  if (receipt !== null) details.mpesaReceiptNumber = String(receipt);
  if (date !== null) details.transactionDate = String(date);
  // Keep our own (already validated) number if Daraja sends something unexpected
  if (phone !== null && /^\d{12}$/.test(String(phone))) details.phoneNumber = String(phone);
  return details;
}

// Task 1 + Task 2: callback processing with idempotency

/**
 * Processes the body of a Daraja STK callback. Never throws for bad input.
 * Resolves with { outcome } where outcome is one of:
 *   completed | failed | cancelled | duplicate | unknown | invalid
 */
async function processCallback(body) {
  const stk = body && body.Body && body.Body.stkCallback;
  if (!stk || typeof stk !== 'object') {
    console.warn('Callback ignored: body does not contain Body.stkCallback');
    return { outcome: 'invalid' };
  }

  const { CheckoutRequestID: rawCheckoutId, ResultDesc: rawDesc, CallbackMetadata } = stk;
  const resultCode = parseResultCode(stk.ResultCode);
  if (typeof rawCheckoutId !== 'string' || rawCheckoutId.trim() === '' || resultCode === null) {
    console.warn('Callback ignored: missing or invalid CheckoutRequestID / ResultCode');
    return { outcome: 'invalid' };
  }

  const checkoutRequestId = rawCheckoutId.trim();
  const resultDesc = typeof rawDesc === 'string' ? rawDesc : null;
  const shownId = clean(checkoutRequestId);
  console.log(`Callback received: CheckoutRequestID=${shownId} ResultCode=${resultCode}`);

  const prisma = getPrisma();
  const payment = await prisma.payment.findUnique({ where: { checkoutRequestId } });

  // Idempotency (a): nothing to update
  if (!payment) {
    console.warn(`Callback for unknown CheckoutRequestID: ${shownId}`);
    return { outcome: 'unknown' };
  }

  const status = statusFromResultCode(resultCode);
  const details = status === 'completed' ? extractSuccessDetails(CallbackMetadata) : {};

  // Idempotency (b): already resolved, so skip.
  if (payment.status !== 'pending') {
    // One narrow exception: a payment marked completed by the query endpoint has no receipt
    // number (the query API doesn't return one). Let the real callback fill that in, and
    // nothing else, so the receipt isn't lost forever.
    const canFillReceipt =
      payment.status === 'completed' &&
      payment.mpesaReceiptNumber === null &&
      status === 'completed' &&
      details.mpesaReceiptNumber !== undefined;

    if (!canFillReceipt) {
      console.log(`Duplicate callback for ${shownId}. Already ${payment.status}. Skipping.`);
      return { outcome: 'duplicate' };
    }

    const filled = await prisma.payment.updateMany({
      where: { checkoutRequestId, status: 'completed', mpesaReceiptNumber: null },
      data: {
        mpesaReceiptNumber: details.mpesaReceiptNumber,
        ...(details.transactionDate !== undefined ? { transactionDate: details.transactionDate } : {}),
      },
    });
    if (filled.count === 0) {
      console.log(`Duplicate callback for ${shownId}. Already completed. Skipping.`);
      return { outcome: 'duplicate' };
    }
    console.log(`Payment ${shownId} receipt recorded from callback. Receipt: ${clean(details.mpesaReceiptNumber)}`);
    return { outcome: 'receipt-recorded' };
  }

  if (status === 'completed') {
    if (details.mpesaReceiptNumber === undefined) {
      console.warn(`Callback for ${shownId} reports success but has no MpesaReceiptNumber`);
    }
    if (details.amount !== undefined && details.amount !== payment.amount) {
      console.warn(
        `Callback amount (${details.amount}) differs from the requested amount (${payment.amount}) for ${shownId}`
      );
    }
  }

  // Only update if the payment is STILL pending. Doing the check inside the UPDATE (not just
  // in the lookup above) makes this safe when two identical callbacks arrive at the same time.
  const { count } = await prisma.payment.updateMany({
    where: { checkoutRequestId, status: 'pending' },
    data: { status, resultCode, resultDesc, ...details },
  });

  if (count === 0) {
    const current = await prisma.payment.findUnique({ where: { checkoutRequestId } });
    console.log(`Duplicate callback for ${shownId}. Already ${current ? current.status : 'processed'}. Skipping.`);
    return { outcome: 'duplicate' };
  }

  if (status === 'completed') {
    console.log(`Payment ${shownId} completed. Receipt: ${clean(details.mpesaReceiptNumber ?? 'N/A')}`);
  } else if (status === 'cancelled') {
    console.log(`Payment ${shownId} cancelled: ${clean(resultDesc ?? 'Request cancelled by user.')}`);
  } else {
    console.log(`Payment ${shownId} failed: ${clean(resultDesc ?? 'Unknown reason')} (ResultCode ${resultCode})`);
  }
  return { outcome: status };
}

// Callbacks are processed after the HTTP response has been sent, so we track the in-flight
// work. That lets tests and the simulator wait for it deterministically.
const inflight = new Set();

/** Starts processing in the background and never lets an error escape. */
function handleCallbackInBackground(body) {
  const work = processCallback(body).catch((err) => {
    console.error(`Error processing callback: ${err.message}`);
    return { outcome: 'error' };
  });
  inflight.add(work);
  work.finally(() => inflight.delete(work));
  return work;
}

async function whenIdle() {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}

// Bonus: simulated callbacks
function randomReceiptNumber() {
  let suffix = '';
  for (let i = 0; i < 7; i++) suffix += RECEIPT_CHARS[crypto.randomInt(RECEIPT_CHARS.length)];
  return `SIM${suffix}`;
}

/** Builds a payload shaped exactly like Daraja's real STK callback. */
function buildSimulatedCallback(payment, success, timestamp) {
  const stkCallback = {
    MerchantRequestID: payment.merchantRequestId || 'SIM-MERCHANT-REQUEST',
    CheckoutRequestID: payment.checkoutRequestId,
  };

  if (!success) {
    return {
      Body: {
        stkCallback: { ...stkCallback, ResultCode: CANCELLED_BY_USER, ResultDesc: 'Request cancelled by user.' },
      },
    };
  }

  return {
    Body: {
      stkCallback: {
        ...stkCallback,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: payment.amount },
            { Name: 'MpesaReceiptNumber', Value: randomReceiptNumber() },
            { Name: 'TransactionDate', Value: Number(timestamp) },
            { Name: 'PhoneNumber', Value: Number(payment.phoneNumber) },
          ],
        },
      },
    },
  };
}

module.exports = {
  getCallbackValue,
  parseResultCode,
  statusFromResultCode,
  extractSuccessDetails,
  processCallback,
  handleCallbackInBackground,
  whenIdle,
  buildSimulatedCallback,
  randomReceiptNumber,
};
