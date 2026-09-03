-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'succeeded', 'dead');

-- CreateEnum
CREATE TYPE "DeliveryTrigger" AS ENUM ('automatic', 'manual_replay');

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3),
    "triggeredBy" "DeliveryTrigger" NOT NULL DEFAULT 'automatic',
    "replayOfDeliveryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Delivery_eventId_idx" ON "Delivery"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_eventId_automatic_key" ON "Delivery"("eventId") WHERE ("triggeredBy" = 'automatic');

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_replayOfDeliveryId_fkey" FOREIGN KEY ("replayOfDeliveryId") REFERENCES "Delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
