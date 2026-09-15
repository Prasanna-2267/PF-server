import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const createPrismaClient = (): PrismaClient => {
  const connectionString =
    process.env.DATABASE_URL?.trim() || process.env.DIRECT_URL?.trim();

  if (!connectionString) {
    throw new Error(
      "A PostgreSQL connection string is required in DATABASE_URL or DIRECT_URL.",
    );
  }

  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
};

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type PrismaDatabaseClient = PrismaClient;
