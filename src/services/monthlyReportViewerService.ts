import { randomBytes } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { forbidden, notFound, serviceUnavailable } from "../errors/api-error.js";
import { getStorageProvider } from "../integrations/provider-registry.js";

const VIEWER_TTL_MS = 15 * 60_000;
const MAX_REPORT_BYTES = 30 * 1024 * 1024;
type ReportContent = { buffer: Buffer; pageCount: number; fileName: string; mimeType: "application/pdf"; expiresAt: Date };
const reportCache = new Map<string, { expiresAt: Date; content: ReportContent }>();

const include = {
  report: { select: { id: true, userId: true, courseId: true, yearMonth: true, status: true, storageKey: true, pdfSizeBytes: true, productContentItemId: true, generatedAt: true } },
  user: { select: { email: true, status: true, deletedAt: true } },
  userSession: { select: { userId: true, expiresAt: true, revokedAt: true } },
} as const;

async function activeEntitlement(userId: string, productContentItemId: string | null) {
  if (!productContentItemId) return null;
  return prisma.entitlement.findFirst({ where: { userId, contentItemId: productContentItemId, resourceType: "MONTHLY_REPORT", status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true, expiresAt: true } });
}

async function accessibleReport(userId: string, reportId: string) {
  const report = await prisma.learnerMonthlyReport.findFirst({ where: { id: reportId, userId }, select: { id: true, userId: true, yearMonth: true, status: true, storageKey: true, pdfSizeBytes: true, productContentItemId: true } });
  if (!report) throw notFound("MONTHLY_REPORT_NOT_FOUND", "The monthly report was not found.");
  if (report.status !== "READY" || !report.storageKey) throw forbidden("MONTHLY_REPORT_NOT_READY", "The monthly report is not ready to view yet.");
  const entitlement = await activeEntitlement(userId, report.productContentItemId);
  if (!entitlement) throw forbidden("MONTHLY_REPORT_ENTITLEMENT_REQUIRED", "An active Monthly Report entitlement is required.");
  return { report, entitlement };
}

async function requireOwnedSession(userId: string, userSessionId: string, viewerSessionId: string) {
  const viewer = await prisma.monthlyReportViewerSession.findFirst({ where: { id: viewerSessionId, userId, userSessionId }, include });
  if (!viewer) throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected report viewer session was not found.");
  if (viewer.status !== "ACTIVE") throw forbidden("VIEWER_SESSION_CLOSED", "This protected report viewer session is closed.");
  if (viewer.expiresAt <= new Date()) {
    await prisma.monthlyReportViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    throw forbidden("VIEWER_SESSION_EXPIRED", "This protected report viewer session expired. Open the report again.");
  }
  await accessibleReport(userId, viewer.reportId);
  return viewer;
}

async function requireTicket(viewerSessionId: string, ticket: string) {
  if (!/^[a-f0-9]{24}$/i.test(ticket)) throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected report viewer session was not found.");
  const viewer = await prisma.monthlyReportViewerSession.findFirst({ where: { id: viewerSessionId, traceId: ticket }, include });
  const now = new Date();
  if (!viewer || viewer.userSession.userId !== viewer.userId || viewer.userSession.revokedAt || viewer.userSession.expiresAt <= now || viewer.user.status !== "ACTIVE" || viewer.user.deletedAt) throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected report viewer session was not found.");
  if (viewer.status !== "ACTIVE") throw forbidden("VIEWER_SESSION_CLOSED", "This protected report viewer session is closed.");
  if (viewer.expiresAt <= now) {
    await prisma.monthlyReportViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    throw forbidden("VIEWER_SESSION_EXPIRED", "This protected report viewer session expired. Open the report again.");
  }
  await accessibleReport(viewer.userId, viewer.reportId);
  return viewer;
}

export async function createMonthlyReportViewerSession(userId: string, userSessionId: string, reportId: string) {
  const { report, entitlement } = await accessibleReport(userId, reportId);
  const now = new Date();
  const ttl = new Date(now.getTime() + VIEWER_TTL_MS);
  const expiresAt = entitlement.expiresAt && entitlement.expiresAt < ttl ? entitlement.expiresAt : ttl;
  await prisma.monthlyReportViewerSession.updateMany({ where: { userId, userSessionId, reportId, status: "ACTIVE" }, data: { status: "CLOSED", closedAt: now } });
  const viewer = await prisma.monthlyReportViewerSession.create({ data: { userId, userSessionId, reportId, traceId: randomBytes(12).toString("hex"), expiresAt } });
  return { viewerSessionId: viewer.id, status: "allowed" as const, expiresAt, contentUrl: `/api/protected-viewer/${viewer.id}/content?ticket=${viewer.traceId}`, report: { id: report.id, title: `Monthly Report - ${report.yearMonth}`, mimeType: "application/pdf" as const } };
}

async function render(viewer: Awaited<ReturnType<typeof requireTicket>> | Awaited<ReturnType<typeof requireOwnedSession>>) {
  const cached = reportCache.get(viewer.id);
  if (cached && cached.expiresAt > new Date()) return cached.content;
  if (cached) reportCache.delete(viewer.id);
  const key = viewer.report.storageKey;
  if (!key) throw notFound("MONTHLY_REPORT_NOT_READY", "The report file is unavailable.");
  if (viewer.report.pdfSizeBytes && viewer.report.pdfSizeBytes > BigInt(MAX_REPORT_BYTES)) throw serviceUnavailable("MONTHLY_REPORT_TOO_LARGE", "The report is too large for protected viewing.");
  const url = await getStorageProvider().createDownloadUrl(key, 60);
  let response: Response;
  try { response = await fetch(url, { headers: { accept: "application/pdf" } }); } catch { throw serviceUnavailable("MONTHLY_REPORT_SOURCE_UNAVAILABLE", "The report file is temporarily unavailable."); }
  if (!response.ok) throw serviceUnavailable("MONTHLY_REPORT_SOURCE_UNAVAILABLE", "The report file is temporarily unavailable.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REPORT_BYTES || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw serviceUnavailable("MONTHLY_REPORT_PDF_INVALID", "The stored report file is invalid.");
  const content: ReportContent = { buffer, pageCount: 1, fileName: `Monthly Report - ${viewer.report.yearMonth}.pdf`, mimeType: "application/pdf", expiresAt: viewer.expiresAt };
  reportCache.set(viewer.id, { expiresAt: viewer.expiresAt, content });
  await prisma.monthlyReportViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { lastSeenAt: new Date() } });
  return content;
}

export async function getMonthlyReportViewerContentByTicket(viewerSessionId: string, ticket: string) { return render(await requireTicket(viewerSessionId, ticket)); }
export async function authorizeMonthlyReportViewerTicket(viewerSessionId: string, ticket: string, expectedMimeType?: string) {
  const viewer = await requireTicket(viewerSessionId, ticket);
  if (expectedMimeType && expectedMimeType !== "application/pdf") throw notFound("MONTHLY_REPORT_NOT_FOUND", "The report format does not match this viewer.");
  return { id: viewer.id, title: `Monthly Report - ${viewer.report.yearMonth}`, mimeType: "application/pdf", expiresAt: viewer.expiresAt };
}

export async function closeMonthlyReportViewerSession(userId: string, userSessionId: string, viewerSessionId: string) {
  const viewer = await prisma.monthlyReportViewerSession.findFirst({ where: { id: viewerSessionId, userId, userSessionId }, select: { id: true, status: true } });
  if (!viewer) throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected report viewer session was not found.");
  if (viewer.status === "ACTIVE") await prisma.monthlyReportViewerSession.update({ where: { id: viewer.id }, data: { status: "CLOSED", closedAt: new Date(), lastSeenAt: new Date() } });
  reportCache.delete(viewer.id);
}

