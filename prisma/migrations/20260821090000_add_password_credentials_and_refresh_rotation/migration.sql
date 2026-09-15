-- Additive authentication support only. This migration must not be deployed until
-- the target environment's migration history has been reconciled and reviewed.

ALTER TABLE "UserSession"
ADD COLUMN "refreshTokenHash" VARCHAR(64),
ADD COLUMN "rotationCounter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastRotatedAt" TIMESTAMP(3);

CREATE TABLE "PasswordCredential" (
    "userId" UUID NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasswordCredential_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "PasswordCredential"
ADD CONSTRAINT "PasswordCredential_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
