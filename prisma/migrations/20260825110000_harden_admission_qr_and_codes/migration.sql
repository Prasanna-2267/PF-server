-- Admission QR rotation keeps exactly the latest issued, unused session valid.
ALTER TABLE "AcademyQrSession"
ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "AcademyQrSession_academyId_revokedAt_expiresAt_idx"
ON "AcademyQrSession"("academyId", "revokedAt", "expiresAt");

-- NULL means unlimited usage / no expiration. Existing bounded codes are preserved.
ALTER TABLE "AdmissionCode"
ALTER COLUMN "maxUses" DROP NOT NULL,
ALTER COLUMN "expiresAt" DROP NOT NULL;
