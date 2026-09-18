import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { getEmailProvider, getStorageProvider } from "../integrations/provider-registry.js";
import { getConfig } from "../config/env.js";
import { monthBounds } from "./learnerTime.js";

export const MONTHLY_REPORT_EMAIL_JOB = "MONTHLY_REPORT_EMAIL";
const MAX_EMAIL_REPORT_BYTES = 10 * 1024 * 1024;
const payloadSchema = z.object({ reportId: z.string().uuid(), version: z.number().int().positive() }).strict();

export async function deliverMonthlyReportEmail(value: unknown) {
  const { reportId, version } = payloadSchema.parse(value);
  const report = await prisma.learnerMonthlyReport.findFirst({
    where: { id: reportId, version, status: "READY", storageKey: { not: null } },
    include: { user: { select: { email: true, fullName: true, status: true, deletedAt: true } } },
  });
  if (!report || report.user.status !== "ACTIVE" || report.user.deletedAt) return { skipped: true };
  if (!report.storageKey) return { skipped: true };
  if (report.pdfSizeBytes && report.pdfSizeBytes > BigInt(MAX_EMAIL_REPORT_BYTES)) throw new Error("MONTHLY_REPORT_EMAIL_ATTACHMENT_TOO_LARGE");

  const storage = getStorageProvider();
  const sourceUrl = await storage.createDownloadUrl(report.storageKey, 300);
  const response = await fetch(sourceUrl, { headers: { accept: "application/pdf" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`MONTHLY_REPORT_EMAIL_SOURCE_HTTP_${response.status}`);
  const pdf = Buffer.from(await response.arrayBuffer());
  if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) || pdf.length > MAX_EMAIL_REPORT_BYTES) throw new Error("MONTHLY_REPORT_EMAIL_PDF_INVALID");
  if (report.pdfChecksumSha256 && createHash("sha256").update(pdf).digest("hex") !== report.pdfChecksumSha256) throw new Error("MONTHLY_REPORT_EMAIL_CHECKSUM_MISMATCH");

  const reportMonth = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(monthBounds(report.yearMonth).start);
  const reportUrl = new URL("monthly-report", getConfig().branding.appUrl).toString();
  return getEmailProvider().send({
    to: report.user.email,
    recipientSource: "registered-user",
    template: "monthly-report-ready",
    variables: { userName: report.user.fullName, reportMonth, reportUrl },
    attachments: [{ fileName: `Parallax-Flow-Monthly-Report-${report.yearMonth}.pdf`, contentType: "application/pdf", contentBase64: pdf.toString("base64") }],
    idempotencyKey: `monthly-report-email:${report.id}:v${report.version}`,
  });
}
