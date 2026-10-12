-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "checkoutRequestId" TEXT NOT NULL,
    "merchantRequestId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "accountReference" TEXT,
    "transactionDesc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultCode" INTEGER,
    "resultDesc" TEXT,
    "mpesaReceiptNumber" TEXT,
    "transactionDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_checkoutRequestId_key" ON "Payment"("checkoutRequestId");
