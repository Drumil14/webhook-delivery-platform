-- AlterTable
ALTER TABLE "Delivery" ALTER COLUMN "maxAttempts" SET DEFAULT 6;

-- CreateIndex
CREATE INDEX "Delivery_status_nextRetryAt_idx" ON "Delivery"("status", "nextRetryAt");
