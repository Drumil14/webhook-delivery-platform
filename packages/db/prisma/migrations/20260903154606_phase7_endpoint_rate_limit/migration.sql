-- CreateTable
CREATE TABLE "EndpointRateWindow" (
    "endpointId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EndpointRateWindow_pkey" PRIMARY KEY ("endpointId","windowStart")
);

-- AddForeignKey
ALTER TABLE "EndpointRateWindow" ADD CONSTRAINT "EndpointRateWindow_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

