/**
 * Creates (or resets) a pending payment so you can try the callback / query / simulator
 * endpoints with curl without sending a real STK Push.
 *
 *   npm run seed                      -> ws_CO_TEST_001
 *   npm run seed -- ws_CO_TEST_002    -> custom CheckoutRequestID
 */
const { getPrisma, disconnect } = require('../db');

async function main() {
  const checkoutRequestId = process.argv[2] || 'ws_CO_TEST_001';
  const prisma = getPrisma();
  const data = {
    merchantRequestId: '29115-34620561-1',
    phoneNumber: '254712345678',
    amount: 100,
    accountReference: 'PayLink',
    transactionDesc: 'Test payment',
    status: 'pending',
    resultCode: null,
    resultDesc: null,
    mpesaReceiptNumber: null,
    transactionDate: null,
  };
  const payment = await prisma.payment.upsert({
    where: { checkoutRequestId },
    create: { checkoutRequestId, ...data },
    update: data,
  });
  console.log(`Payment ${payment.checkoutRequestId} is pending (id ${payment.id})`);
}

main()
  .catch((err) => {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(disconnect);
