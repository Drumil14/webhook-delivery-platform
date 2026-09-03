-- CreateTable
CREATE TABLE "DemoReceiverState" (
    "deliveryId" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoReceiverState_pkey" PRIMARY KEY ("deliveryId")
);
