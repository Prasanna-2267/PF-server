import { prisma } from "../src/db/prisma.js";

async function main() {
  const [publishedPackages, publishedPaidContent, orders, entitlements] = await Promise.all([
    prisma.package.count({ where: { status: "PUBLISHED", deletedAt: null } }),
    prisma.contentItem.count({ where: { kind: "FILE", accessType: "PAID", status: "PUBLISHED", deletedAt: null } }),
    prisma.order.count(),
    prisma.entitlement.count(),
  ]);
  console.log(JSON.stringify({ databaseConnected: true, publishedPackages, publishedPaidContent, orders, entitlements }));
}

main().finally(() => prisma.$disconnect());
