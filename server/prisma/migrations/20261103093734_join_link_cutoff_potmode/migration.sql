-- AlterTable
ALTER TABLE "Guest" ADD COLUMN "claimedAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "depositCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "hostTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "joinToken" TEXT,
    "graceHours" INTEGER NOT NULL DEFAULT 2,
    "potMode" TEXT NOT NULL DEFAULT 'share',
    "endedAt" DATETIME,
    "settlementStartedAt" DATETIME,
    "settledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Event" ("createdAt", "currency", "depositCents", "endedAt", "hostTokenHash", "id", "settledAt", "settlementStartedAt", "startsAt", "status", "title") SELECT "createdAt", "currency", "depositCents", "endedAt", "hostTokenHash", "id", "settledAt", "settlementStartedAt", "startsAt", "status", "title" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE UNIQUE INDEX "Event_hostTokenHash_key" ON "Event"("hostTokenHash");
CREATE UNIQUE INDEX "Event_joinToken_key" ON "Event"("joinToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
