import { prisma } from "../db/prisma.js";
import * as notes from "./noteViewerService.js";
import * as reports from "./monthlyReportViewerService.js";

async function isReportSession(viewerSessionId: string) {
  return Boolean(await prisma.monthlyReportViewerSession.findUnique({ where: { id: viewerSessionId }, select: { id: true } }));
}

export async function authorizeViewerTicket(viewerSessionId: string, ticket: string, expectedMimeType?: string) {
  return await isReportSession(viewerSessionId) ? reports.authorizeMonthlyReportViewerTicket(viewerSessionId, ticket, expectedMimeType) : notes.authorizeViewerTicket(viewerSessionId, ticket, expectedMimeType);
}

export async function getViewerContentByTicket(viewerSessionId: string, ticket: string) {
  return await isReportSession(viewerSessionId) ? reports.getMonthlyReportViewerContentByTicket(viewerSessionId, ticket) : notes.getViewerContentByTicket(viewerSessionId, ticket);
}

export async function getViewerStreamByTicket(viewerSessionId: string, ticket: string, range?: string) {
  return notes.getViewerStreamByTicket(viewerSessionId, ticket, range);
}

export const safeInlineFileName = notes.safeInlineFileName;
