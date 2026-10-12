# Week 9 Day 3: Callback Handling

Continues the Day 2 STK Push project. Payments now live in PostgreSQL (Prisma), Daraja's callback updates them, duplicate callbacks are ignored, a query endpoint reconciles payments whose callback never arrived, and a simulator lets you test the whole flow without ngrok or the Daraja sandbox.

## Setup

```bash
npm install
cp .env.example .env               # add Daraja credentials, DATABASE_URL and your ngrok callback URL
npx prisma migrate dev --name init # applies prisma/migrations and generates the client
npm run dev                        # or: npm start
npm test                           # 60 tests; needs DATABASE_URL, Daraja itself is mocked
```

## Project structure

| File | Purpose |
| --- | --- |
| `server.js` | Routes: STK push, callback, query, simulator, logs, health |
| `callback.js` | `getCallbackValue`, `processCallback` (idempotent), simulated payload builder |
| `mpesa.js` | Day 1 and 2 functions plus `querySTKStatus` |
| `phone.js` | Phone formatting and masking |
| `db.js` | Lazy Prisma client with the pg adapter |
| `prisma/` | `schema.prisma` (Payment model) and the init migration |
| `scripts/seed-test-payment.js` | Creates or resets a pending payment for curl testing |
| `test.js` | `npm test` suite |

## Try it with curl

Create a pending payment to play with (this is what an STK push does for real):

```bash
npm run seed                       # creates ws_CO_TEST_001 as pending
npm run seed -- ws_CO_TEST_002     # or any other id
```

### Task 1 and 2: `POST /api/mpesa/callback`

```bash
# First callback: processed
curl -X POST http://localhost:3000/api/mpesa/callback \
  -H "Content-Type: application/json" \
  -d '{
    "Body": {
      "stkCallback": {
        "MerchantRequestID": "29115-34620561-1",
        "CheckoutRequestID": "ws_CO_TEST_001",
        "ResultCode": 0,
        "ResultDesc": "The service request is processed successfully.",
        "CallbackMetadata": {
          "Item": [
            { "Name": "Amount", "Value": 100 },
            { "Name": "MpesaReceiptNumber", "Value": "SHK4G7Y8DR" },
            { "Name": "TransactionDate", "Value": 20260504143055 },
            { "Name": "PhoneNumber", "Value": 254712345678 }
          ]
        }
      }
    }
  }'

# Second callback (same payload): acknowledged, then skipped
curl -X POST http://localhost:3000/api/mpesa/callback -H "Content-Type: application/json" -d '<same payload>'
```

Both return `200`:

```json
{ "ResultCode": 0, "ResultDesc": "Accepted" }
```

Server console:

```text
Callback received: CheckoutRequestID=ws_CO_TEST_001 ResultCode=0
Payment ws_CO_TEST_001 completed. Receipt: SHK4G7Y8DR
Callback received: CheckoutRequestID=ws_CO_TEST_001 ResultCode=0
Duplicate callback for ws_CO_TEST_001. Already completed. Skipping.
```

Database after both calls (updated once):

```text
status = completed | resultCode = 0 | mpesaReceiptNumber = SHK4G7Y8DR | transactionDate = 20260504143055
```

A cancelled payment (`ResultCode: 1032`) is stored as `cancelled`, any other non-zero code as `failed`:

```text
Payment ws_CO_TEST_004 cancelled: Request cancelled by user.
Payment ws_CO_TEST_005 failed: The balance is insufficient for the transaction. (ResultCode 1)
```

**How the handler works**

- It answers `200` first, then processes in the background, so Safaricom never retries because of a slow database. Malformed bodies and database errors during processing also still get `200` (they are logged).
- **Idempotency:** unknown `CheckoutRequestID` is logged and ignored. A payment that is not `pending` is logged as a duplicate and skipped. The update itself is `UPDATE ... WHERE checkoutRequestId = ? AND status = 'pending'`, so even two identical callbacks arriving at the same moment cannot both win.
- One deliberate exception: a payment completed through the query endpoint has no receipt number (Daraja's query API doesn't return one). If the real callback arrives later, only the receipt number and transaction date are filled in, and nothing else changes.
- `PhoneNumber` from the callback only replaces the stored number if it is a plain 12-digit number, in case Daraja masks it.

### Task 3: `POST /api/mpesa/query`

```bash
curl -X POST http://localhost:3000/api/mpesa/query \
  -H "Content-Type: application/json" \
  -d '{"checkoutRequestId": "ws_CO_TEST_001"}'
```

Resolved payment, answered from the database (`200`):

```json
{
  "success": true,
  "data": {
    "status": "completed",
    "resultCode": 0,
    "resultDesc": "The service request is processed successfully.",
    "mpesaReceiptNumber": "SHK4G7Y8DR",
    "amount": 100,
    "phoneNumber": "254712345678"
  }
}
```

Unknown id (`404`):

```json
{ "success": false, "error": "Payment not found" }
```

A missing `checkoutRequestId` returns `400`. A payment that is still `pending` is looked up with Daraja's STK Push Query API (`ResultCode` `0` = completed, `1032` = cancelled, anything else = failed) and the result is saved. If Daraja can't be reached, times out, or hasn't got a result yet, you get:

```json
{
  "success": true,
  "data": { "status": "pending", "message": "Payment is still being processed. Try again in a few seconds." }
}
```

If a callback resolves the payment while the query is in flight, the callback's result is kept.

### Bonus: `POST /api/mpesa/simulate-callback`

```bash
curl -X POST http://localhost:3000/api/mpesa/simulate-callback \
  -H "Content-Type: application/json" \
  -d '{"checkoutRequestId": "ws_CO_TEST_001", "success": true}'
```

```json
{
  "success": true,
  "message": "Simulated successful payment callback sent.",
  "simulated": {
    "resultCode": 0,
    "resultDesc": "The service request is processed successfully.",
    "mpesaReceiptNumber": "SIMIEHZXVJ"
  },
  "data": {
    "status": "completed",
    "resultCode": 0,
    "resultDesc": "The service request is processed successfully.",
    "mpesaReceiptNumber": "SIMIEHZXVJ",
    "amount": 100,
    "phoneNumber": "254712345678"
  }
}
```

`"success": false` sends `ResultCode: 1032` / `"Request cancelled by user."` and the payment becomes `cancelled`. The simulator posts the payload to this server's own `/api/mpesa/callback` over loopback, so it exercises exactly the code Daraja would. It returns `404` for unknown ids, `400` for a non-boolean `success`, and `403` when `MPESA_ENV=production`.

### Full local flow without ngrok

```bash
curl -X POST localhost:3000/api/mpesa/stkpush -H "Content-Type: application/json" \
  -d '{"phoneNumber":"0712345678","amount":100,"accountReference":"PayLink","transactionDesc":"Test"}'
# copy data.checkoutRequestId, then:
curl -X POST localhost:3000/api/mpesa/simulate-callback -H "Content-Type: application/json" \
  -d '{"checkoutRequestId":"<id>","success":true}'
curl -X POST localhost:3000/api/mpesa/query -H "Content-Type: application/json" -d '{"checkoutRequestId":"<id>"}'
```
