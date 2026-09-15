import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertIntegrationDatabase } from "../tests/integration-database-guard.js";

const testUrl = assertIntegrationDatabase("RUN_BACKEND_INTEGRATION");
process.env.DATABASE_URL = testUrl;
process.env.DIRECT_URL = testUrl;
const prismaCli = fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url));

function runPrisma(args: string[]): void {
  const result = spawnSync(process.execPath, [prismaCli, ...args], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`prisma ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

runPrisma(["migrate", "deploy"]);
const { resetIntegrationData } = await import("./test-database.js");
const { prisma } = await import("../db/prisma.js");
await prisma.$executeRawUnsafe('ALTER TABLE "ContentItem" VALIDATE CONSTRAINT "ContentItem_kind_storage_check"');
await prisma.$executeRawUnsafe('ALTER TABLE "QuestionOption" VALIDATE CONSTRAINT "QuestionOption_single_parent_check"');
await resetIntegrationData();
await prisma.$disconnect();
runPrisma(["db", "seed"]);
runPrisma(["db", "seed"]);
