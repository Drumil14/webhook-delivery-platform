-- CreateEnum
CREATE TYPE "DeliveryAttemptOutcome" AS ENUM ('success', 'failure', 'timeout', 'network_error');

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "requestHeaders" JSONB NOT NULL,
    "responseStatus" INTEGER,
    "responseHeaders" JSONB,
    "responseBodySnippet" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "resolvedIp" TEXT,
    "outcome" "DeliveryAttemptOutcome" NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryAttempt_deliveryId_attemptedAt_idx" ON "DeliveryAttempt"("deliveryId", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_deliveryId_attemptNumber_key" ON "DeliveryAttempt"("deliveryId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
