import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prisma } from "../db/prisma.js";
import { getConfig } from "../config/env.js";
import { getEmailProvider } from "../integrations/provider-registry.js";
import { generateMonthlyReportPreviewForTesting } from "../services/monthlyReportService.js";

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const email = argument("email")?.toLowerCase();
const requestedMonth = argument("month");
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Usage: npm run reports:test-delivery -- --email registered@example.com [--month YYYY-MM]");
if (requestedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)) throw new Error("--month must use YYYY-MM format.");
if (getConfig().environment === "production") throw new Error("This preview command is disabled in production.");

try {
  const user = await prisma.user.findFirst({ where: { email, status: "ACTIVE", deletedAt: null }, select: { id: true, email: true, fullName: true } });
  if (!user) throw new Error("No active registered user was found for that email.");
  const report = await prisma.learnerMonthlyReport.findFirst({
    where: {
      userId: user.id,
      ...(requestedMonth ? { yearMonth: requestedMonth } : {}),
      product: { is: { entityType: "MONTHLY_REPORT", status: "PUBLISHED", deletedAt: null } },
      entitlement: { is: { status: "ACTIVE" } },
    },
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  if (!report) throw new Error("No purchased Monthly Report schedule was found for this user and month.");

  const preview = await generateMonthlyReportPreviewForTesting(report.id);
  const reportMonth = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${preview.report.yearMonth}-01T00:00:00.000Z`));
  const outputDirectory = resolve(process.cwd(), ".tmp", "monthly-report-tests");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, `monthly-report-${preview.report.yearMonth}-${preview.report.id}.pdf`);
  await writeFile(outputPath, preview.pdf);

  const sent = await getEmailProvider().send({
    to: user.email,
    recipientSource: "registered-user",
    template: "monthly-report-ready",
    variables: { userName: user.fullName, reportMonth, reportUrl: new URL("monthly-report", getConfig().branding.appUrl).toString() },
    attachments: [{ fileName: `Parallax-Flow-Monthly-Report-${preview.report.yearMonth}.pdf`, contentType: "application/pdf", contentBase64: preview.pdf.toString("base64") }],
    idempotencyKey: `monthly-report-test:${preview.report.id}:${Date.now()}`,
  });

  console.log(JSON.stringify({ success: true, recipient: user.email, yearMonth: preview.report.yearMonth, outputPath, sizeBytes: preview.pdf.length, providerMessageId: sent.providerMessageId }, null, 2));
} finally {
  await prisma.$disconnect();
}
