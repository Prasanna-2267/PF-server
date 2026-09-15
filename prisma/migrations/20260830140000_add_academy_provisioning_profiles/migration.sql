ALTER TABLE "Academy"
  ADD COLUMN "academyCode" TEXT,
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "academyType" TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "establishedYear" INTEGER,
  ADD COLUMN "socialLinks" JSONB;

CREATE UNIQUE INDEX "Academy_academyCode_key" ON "Academy"("academyCode");
CREATE INDEX "Academy_academyCode_idx" ON "Academy"("academyCode");

CREATE TABLE "AcademyProfile" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "onboardingStatus" TEXT NOT NULL DEFAULT 'SETUP_PENDING',
  "createdById" UUID NOT NULL, "logoStoragePath" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AcademyProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyProfile_academyId_key" ON "AcademyProfile"("academyId");
CREATE INDEX "AcademyProfile_createdById_idx" ON "AcademyProfile"("createdById");
CREATE INDEX "AcademyProfile_onboardingStatus_idx" ON "AcademyProfile"("onboardingStatus");

CREATE TABLE "AcademyContact" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "role" TEXT NOT NULL, "fullName" TEXT NOT NULL,
  "email" TEXT, "phone" TEXT, "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AcademyContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AcademyContact_academyId_role_idx" ON "AcademyContact"("academyId", "role");
CREATE INDEX "AcademyContact_academyId_isPrimary_idx" ON "AcademyContact"("academyId", "isPrimary");

CREATE TABLE "AcademyLegalProfile" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "legalName" TEXT, "entityType" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  "panStatus" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE', "pan" TEXT, "tan" TEXT, "gstStatus" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  "gstin" TEXT, "gstState" TEXT, "gstRegistrationType" TEXT, "gstRegistrationDate" TIMESTAMP(3),
  "gstCertificateStoragePath" TEXT, "placeOfSupply" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AcademyLegalProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyLegalProfile_academyId_key" ON "AcademyLegalProfile"("academyId");
CREATE INDEX "AcademyLegalProfile_gstin_idx" ON "AcademyLegalProfile"("gstin");
CREATE INDEX "AcademyLegalProfile_pan_idx" ON "AcademyLegalProfile"("pan");

CREATE TABLE "AcademyAddress" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "kind" TEXT NOT NULL, "addressLine1" TEXT NOT NULL,
  "addressLine2" TEXT, "city" TEXT NOT NULL, "state" TEXT NOT NULL, "country" TEXT NOT NULL DEFAULT 'India',
  "postalCode" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AcademyAddress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyAddress_academyId_kind_key" ON "AcademyAddress"("academyId", "kind");
CREATE INDEX "AcademyAddress_academyId_state_idx" ON "AcademyAddress"("academyId", "state");

CREATE TABLE "AcademyBillingProfile" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "invoiceDisplayName" TEXT, "invoiceEmail" TEXT,
  "billingContactName" TEXT, "billingContactPhone" TEXT, "purchaseOrderRequired" BOOLEAN NOT NULL DEFAULT false,
  "currency" TEXT NOT NULL DEFAULT 'INR', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AcademyBillingProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyBillingProfile_academyId_key" ON "AcademyBillingProfile"("academyId");

CREATE TABLE "AcademyAcademicOffering" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "category" TEXT NOT NULL, "program" TEXT,
  "branch" TEXT, "batch" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AcademyAcademicOffering_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyAcademicOffering_unique" ON "AcademyAcademicOffering"("academyId", "category", "program", "branch", "batch");
CREATE INDEX "AcademyAcademicOffering_academyId_category_idx" ON "AcademyAcademicOffering"("academyId", "category");

CREATE TABLE "AcademyCommercialProfile" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "planKey" TEXT NOT NULL, "subscriptionStatus" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL, "endDate" TIMESTAMP(3), "studentSeatLimit" INTEGER NOT NULL,
  "purchasedSeats" INTEGER NOT NULL DEFAULT 0, "activeSeats" INTEGER NOT NULL DEFAULT 0,
  "additionalSeats" INTEGER NOT NULL DEFAULT 0, "billingCycle" TEXT NOT NULL DEFAULT 'ANNUAL',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AcademyCommercialProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyCommercialProfile_academyId_key" ON "AcademyCommercialProfile"("academyId");
CREATE INDEX "AcademyCommercialProfile_subscriptionStatus_endDate_idx" ON "AcademyCommercialProfile"("subscriptionStatus", "endDate");

CREATE TABLE "AcademyIntegrationProfile" (
  "id" UUID NOT NULL, "academyId" UUID NOT NULL, "zohoOrganizationId" TEXT, "zohoCustomerId" TEXT,
  "zohoCustomerNumber" TEXT, "zohoContactId" TEXT, "zohoCustomerName" TEXT,
  "zohoSyncStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED', "zohoLastSyncedAt" TIMESTAMP(3),
  "zohoLastSyncError" TEXT, "zohoSyncVersion" INTEGER NOT NULL DEFAULT 0, "paymentCustomerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AcademyIntegrationProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyIntegrationProfile_academyId_key" ON "AcademyIntegrationProfile"("academyId");
CREATE INDEX "AcademyIntegrationProfile_zohoCustomerId_idx" ON "AcademyIntegrationProfile"("zohoCustomerId");
CREATE INDEX "AcademyIntegrationProfile_zohoSyncStatus_idx" ON "AcademyIntegrationProfile"("zohoSyncStatus");

ALTER TABLE "AcademyProfile" ADD CONSTRAINT "AcademyProfile_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyProfile" ADD CONSTRAINT "AcademyProfile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AcademyContact" ADD CONSTRAINT "AcademyContact_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyLegalProfile" ADD CONSTRAINT "AcademyLegalProfile_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyAddress" ADD CONSTRAINT "AcademyAddress_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyBillingProfile" ADD CONSTRAINT "AcademyBillingProfile_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyAcademicOffering" ADD CONSTRAINT "AcademyAcademicOffering_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyCommercialProfile" ADD CONSTRAINT "AcademyCommercialProfile_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyIntegrationProfile" ADD CONSTRAINT "AcademyIntegrationProfile_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
