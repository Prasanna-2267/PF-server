-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAID', 'FAILED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('NONE', 'PENDING', 'PARTIAL', 'FULL');

-- CreateEnum
CREATE TYPE "OrderAccessStatus" AS ENUM ('PENDING', 'GRANTED', 'REVOKED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "CouponScope" AS ENUM ('ALL', 'PACKAGES', 'SUBJECTS');

-- CreateEnum
CREATE TYPE "LearningResourceType" AS ENUM ('COURSE', 'PACKAGE', 'LESSON', 'PREMIUM_NOTES', 'SUBJECT', 'OTHER');

-- CreateEnum
CREATE TYPE "EntitlementSource" AS ENUM ('PURCHASE', 'ADMIN_GRANT', 'SUBSCRIPTION', 'PROMOTION');

-- CreateEnum
CREATE TYPE "EntitlementAccessType" AS ENUM ('PERMANENT', 'TIME_LIMITED');

-- CreateEnum
CREATE TYPE "EntitlementStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('ACCESS_GRANTED', 'ACCESS_REVOKED', 'ROLE_CHANGED', 'ACCOUNT_DISABLED', 'ACCOUNT_ENABLED', 'SESSIONS_REVOKED');

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "courseId" UUID,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "refundStatus" "RefundStatus" NOT NULL DEFAULT 'NONE',
    "accessStatus" "OrderAccessStatus" NOT NULL DEFAULT 'PENDING',
    "isComplimentary" BOOLEAN NOT NULL DEFAULT false,
    "receiptNumber" TEXT,
    "paymentMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "contentItemId" UUID,
    "packageId" UUID,
    "resourceType" "LearningResourceType" NOT NULL,
    "titleSnapshot" TEXT NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "totalPrice" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "discountType" "CouponDiscountType" NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "scope" "CouponScope" NOT NULL DEFAULT 'ALL',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponTarget" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "packageId" UUID,
    "subjectId" UUID,

    CONSTRAINT "CouponTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "discountAmount" DECIMAL(10,2) NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "resourceType" "LearningResourceType" NOT NULL,
    "contentItemId" UUID,
    "packageId" UUID,
    "subjectId" UUID,
    "courseId" UUID,
    "resourceTitle" TEXT NOT NULL,
    "source" "EntitlementSource" NOT NULL DEFAULT 'PURCHASE',
    "orderId" UUID,
    "accessType" "EntitlementAccessType" NOT NULL DEFAULT 'PERMANENT',
    "status" "EntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "grantedByAdminId" UUID,
    "reason" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "targetStudentId" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_receiptNumber_key" ON "Order"("receiptNumber");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Order_courseId_status_idx" ON "Order"("courseId", "status");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_contentItemId_idx" ON "OrderItem"("contentItemId");

-- CreateIndex
CREATE INDEX "OrderItem_packageId_idx" ON "OrderItem"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_code_idx" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_enabled_expiresAt_idx" ON "Coupon"("enabled", "expiresAt");

-- CreateIndex
CREATE INDEX "CouponTarget_couponId_idx" ON "CouponTarget"("couponId");

-- CreateIndex
CREATE INDEX "CouponTarget_packageId_idx" ON "CouponTarget"("packageId");

-- CreateIndex
CREATE INDEX "CouponTarget_subjectId_idx" ON "CouponTarget"("subjectId");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_userId_idx" ON "CouponRedemption"("couponId", "userId");

-- CreateIndex
CREATE INDEX "CouponRedemption_orderId_idx" ON "CouponRedemption"("orderId");

-- CreateIndex
CREATE INDEX "Entitlement_userId_status_idx" ON "Entitlement"("userId", "status");

-- CreateIndex
CREATE INDEX "Entitlement_contentItemId_status_idx" ON "Entitlement"("contentItemId", "status");

-- CreateIndex
CREATE INDEX "Entitlement_packageId_status_idx" ON "Entitlement"("packageId", "status");

-- CreateIndex
CREATE INDEX "Entitlement_orderId_idx" ON "Entitlement"("orderId");

-- CreateIndex
CREATE INDEX "AuditEvent_targetStudentId_occurredAt_idx" ON "AuditEvent"("targetStudentId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt");

-- Foreign Keys
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Order" ADD CONSTRAINT "Order_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponTarget" ADD CONSTRAINT "CouponTarget_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponTarget" ADD CONSTRAINT "CouponTarget_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponTarget" ADD CONSTRAINT "CouponTarget_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "ContentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_grantedByAdminId_fkey" FOREIGN KEY ("grantedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_targetStudentId_fkey" FOREIGN KEY ("targetStudentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Custom PostgreSQL Partial Unique Indexes
CREATE UNIQUE INDEX "Coupon_code_ci_key"
ON "Coupon" (LOWER(BTRIM("code")));

CREATE UNIQUE INDEX "Entitlement_user_content_active_key"
ON "Entitlement" ("userId", "contentItemId")
WHERE "status" = 'ACTIVE' AND "contentItemId" IS NOT NULL;

CREATE UNIQUE INDEX "Entitlement_user_package_active_key"
ON "Entitlement" ("userId", "packageId")
WHERE "status" = 'ACTIVE' AND "packageId" IS NOT NULL;

-- Custom PostgreSQL CHECK Constraints
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_resource_xor"
CHECK (
    ("contentItemId" IS NOT NULL AND "packageId" IS NULL)
    OR
    ("contentItemId" IS NULL AND "packageId" IS NOT NULL)
);

ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_resource_xor"
CHECK (
    (
        CASE WHEN "contentItemId" IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN "packageId" IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN "subjectId" IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN "courseId" IS NOT NULL THEN 1 ELSE 0 END
    ) = 1
);

ALTER TABLE "CouponTarget" ADD CONSTRAINT "CouponTarget_resource_check"
CHECK (
    ("packageId" IS NOT NULL AND "subjectId" IS NULL)
    OR
    ("packageId" IS NULL AND "subjectId" IS NOT NULL)
);

ALTER TABLE "Order" ADD CONSTRAINT "Order_monetary_check"
CHECK ("subtotal" >= 0 AND "discountAmount" >= 0 AND "totalAmount" >= 0);

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_monetary_check"
CHECK ("unitPrice" >= 0 AND "totalPrice" >= 0 AND "quantity" > 0);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_check"
CHECK ("amount" >= 0);

ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_discount_check"
CHECK ("discountValue" >= 0 AND ("discountType" != 'PERCENT' OR "discountValue" <= 100));
