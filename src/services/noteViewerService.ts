import { randomBytes } from "node:crypto";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";
import { badRequest, forbidden, notFound, serviceUnavailable } from "../errors/api-error.js";
import { getStorageProvider } from "../integrations/provider-registry.js";
import { assertNoteCanOpen, recordNoteOpened, recordReadingProgress } from "./noteCatalogService.js";
import { ALLOWED_CONTENT_MIME_TYPES } from "../utils/upload-validation.js";

const VIEWER_TTL_MS = 15 * 60_000;
// Content uploads are allowed to exceed 25 MiB. Keep the protected viewer's
// in-memory ceiling high enough for those published documents while retaining
// a firm bound around PDF parsing and watermark generation.
export const MAX_PROTECTED_NOTE_SOURCE_BYTES = 100 * 1024 * 1024;
const SUPPORTED_NOTE_MIME_TYPES = [...ALLOWED_CONTENT_MIME_TYPES];
type ProtectedContent = { buffer: Buffer; pageCount: number; fileName: string; mimeType: string; expiresAt: Date };
const protectedPdfCache = new Map<string, { expiresAt: Date; content: ProtectedContent }>();
const protectedPdfRenderInFlight = new Map<string, Promise<ProtectedContent>>();

const viewerInclude = {
  contentItem: {
    select: {
      id: true,
      name: true,
      mimeType: true,
      size: true,
      storagePath: true,
      attachedLinks: {
        where: { deletedAt: null },
        select: { id: true, url: true, description: true, createdAt: true, updatedAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  },
  user: { select: { email: true, status: true, deletedAt: true } },
  userSession: { select: { userId: true, expiresAt: true, revokedAt: true } },
} satisfies Prisma.NoteViewerSessionInclude;

type AccessibleNote = {
  id: string;
  name: string;
  mimeType: string | null;
  size: bigint;
  storagePath: string;
  courseId: string;
  accessType: "FREE" | "PAID";
  course: { academyId: string | null };
  access: { expiresAt: Date | null };
};

async function loadAccessibleNote(userId: string, contentItemId: string): Promise<AccessibleNote> {
  const authorised = await assertNoteCanOpen(userId, contentItemId);
  const item = await prisma.contentItem.findFirst({
    where: {
      id: contentItemId,
      kind: "FILE",
      status: "PUBLISHED",
      deletedAt: null,
      storagePath: { not: null },
      mimeType: { in: [...SUPPORTED_NOTE_MIME_TYPES] },
      course: {
        status: "ACTIVE",
        deletedAt: null,
        OR: [{ academyId: null }, { academy: { status: "ACTIVE", deletedAt: null } }],
      },
    },
    select: { id: true, name: true, mimeType: true, size: true, storagePath: true, courseId: true, accessType: true, course: { select: { academyId: true } } },
  });
  if (!item?.storagePath) throw notFound("NOTE_NOT_FOUND", "The published note was not found or its format is unsupported.");
  return { ...item, access: { expiresAt: authorised.access.expiresAt } } as AccessibleNote;
}

async function requireViewerSession(userId: string, userSessionId: string, viewerSessionId: string) {
  const viewer = await prisma.noteViewerSession.findFirst({ where: { id: viewerSessionId, userId, userSessionId }, include: viewerInclude });
  if (!viewer) throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected viewer session was not found.");
  if (viewer.status !== "ACTIVE") throw forbidden("VIEWER_SESSION_CLOSED", "This protected viewer session is closed.");
  if (viewer.expiresAt <= new Date()) {
    await prisma.noteViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    throw forbidden("VIEWER_SESSION_EXPIRED", "This protected viewer session expired. Open the note again.");
  }
  const note = await loadAccessibleNote(userId, viewer.contentItemId);
  return { ...viewer, resourceExpiresAt: note.access.expiresAt };
}

async function requireViewerTicket(viewerSessionId: string, ticket: string) {
  if (!/^[a-f0-9]{24}$/i.test(ticket)) throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected viewer session was not found.");
  const viewer = await prisma.noteViewerSession.findFirst({ where: { id: viewerSessionId, traceId: ticket }, include: viewerInclude });
  const now = new Date();
  if (!viewer || viewer.userSession.userId !== viewer.userId || viewer.userSession.revokedAt || viewer.userSession.expiresAt <= now || viewer.user.status !== "ACTIVE" || viewer.user.deletedAt) {
    throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected viewer session was not found.");
  }
  if (viewer.status !== "ACTIVE") throw forbidden("VIEWER_SESSION_CLOSED", "This protected viewer session is closed.");
  if (viewer.expiresAt <= now) {
    await prisma.noteViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    throw forbidden("VIEWER_SESSION_EXPIRED", "This protected viewer session expired. Open the note again.");
  }
  const note = await loadAccessibleNote(viewer.userId, viewer.contentItemId);
  return { ...viewer, resourceExpiresAt: note.access.expiresAt };
}

export async function createViewerSession(userId: string, userSessionId: string, contentItemId: string) {
  const note = await loadAccessibleNote(userId, contentItemId);
  const now = new Date();
  const ttlExpiry = new Date(now.getTime() + VIEWER_TTL_MS);
  const expiresAt = note.access.expiresAt && note.access.expiresAt < ttlExpiry ? note.access.expiresAt : ttlExpiry;
  await prisma.noteViewerSession.updateMany({
    where: { userId, userSessionId, contentItemId, status: "ACTIVE" },
    data: { status: "CLOSED", closedAt: now },
  });
  const viewer = await prisma.noteViewerSession.create({
    data: { userId, userSessionId, contentItemId, traceId: randomBytes(12).toString("hex"), expiresAt },
    include: viewerInclude,
  });
  if (note.mimeType === "application/pdf") {
    // Begin the protected download and watermark pass while the app finishes opening the viewer.
    // The content request joins this same in-flight render instead of doing the work again.
    void renderViewerContent({ ...viewer, resourceExpiresAt: note.access.expiresAt }).catch(() => undefined);
  }
  await recordNoteOpened(userId, contentItemId);
  return {
    viewerSessionId: viewer.id,
    status: "allowed" as const,
    expiresAt: viewer.expiresAt,
    manifestUrl: `/api/student/viewer-sessions/${viewer.id}/manifest`,
    contentUrl: `/api/protected-viewer/${viewer.id}/content?ticket=${viewer.traceId}`,
    note: { id: note.id, title: note.name, mimeType: note.mimeType },
  };
}

export async function getViewerManifest(userId: string, userSessionId: string, viewerSessionId: string) {
  const viewer = await requireViewerSession(userId, userSessionId, viewerSessionId);
  return {
    viewerSessionId: viewer.id,
    title: viewer.contentItem.name,
    mimeType: viewer.contentItem.mimeType,
    pageCount: viewer.pageCount,
    currentPage: viewer.currentPage,
    progressPercent: viewer.progressPercent,
    scrollOffset: viewer.scrollOffset,
    expiresAt: viewer.expiresAt,
    watermark: { displayIdentity: viewer.user.email, traceId: viewer.traceId },
    capabilities: { continuousScroll: true, pinchZoom: true, download: false, print: false },
    attachedLinks: viewer.contentItem.attachedLinks,
  };
}

async function renderWatermarkedPdf(source: Buffer, email: string, traceId: string, openedAt: Date) {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(source, { updateMetadata: false });
  } catch (error) {
    throw serviceUnavailable("PDF_RENDER_FAILED", "The protected PDF could not be prepared for viewing.");
  }
  const font = await document.embedFont(StandardFonts.Helvetica);
  const label = `${email}  |  ${traceId}  |  ${openedAt.toISOString().slice(0, 16)}Z`;
  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.max(8, Math.min(13, width / 48));
    for (const yRatio of [0.22, 0.5, 0.78]) {
      page.drawText(label, {
        x: Math.max(18, width * 0.08),
        y: height * yRatio,
        size: fontSize,
        font,
        color: rgb(0.18, 0.28, 0.55),
        opacity: 0.32,
        rotate: degrees(-24),
      });
    }
  }
  return { buffer: Buffer.from(await document.save({ useObjectStreams: true, addDefaultPage: false })), pageCount: document.getPageCount() };
}

async function renderViewerContentUncached(viewer: Awaited<ReturnType<typeof requireViewerSession>>) {
  if (!viewer.contentItem.storagePath) throw notFound("NOTE_NOT_FOUND", "The note source is unavailable.");
  if (viewer.contentItem.size > BigInt(MAX_PROTECTED_NOTE_SOURCE_BYTES)) throw serviceUnavailable("NOTE_TOO_LARGE_FOR_PROTECTED_VIEW", "This note is too large for protected viewing.");

  const mimeType = viewer.contentItem.mimeType ?? "application/octet-stream";
  const signedUrl = await getStorageProvider().createDownloadUrl(viewer.contentItem.storagePath, 60);
  let response: Response;
  try {
    response = await fetch(signedUrl, { headers: { accept: mimeType } });
  } catch {
    throw serviceUnavailable("NOTE_SOURCE_UNAVAILABLE", "The protected note source is temporarily unavailable.");
  }
  if (!response.ok) throw serviceUnavailable("NOTE_SOURCE_UNAVAILABLE", "The protected note source is temporarily unavailable.");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_PROTECTED_NOTE_SOURCE_BYTES) throw serviceUnavailable("NOTE_TOO_LARGE_FOR_PROTECTED_VIEW", "This note is too large for protected viewing.");
  const source = Buffer.from(await response.arrayBuffer());
  if (source.length > MAX_PROTECTED_NOTE_SOURCE_BYTES) throw serviceUnavailable("NOTE_TOO_LARGE_FOR_PROTECTED_VIEW", "This note is too large for protected viewing.");

  if (mimeType.startsWith("image/")) {
    await prisma.noteViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { pageCount: 1, lastSeenAt: new Date() } });
    return { buffer: source, pageCount: 1, fileName: viewer.contentItem.name, mimeType, expiresAt: viewer.expiresAt };
  }

  const rendered = await renderWatermarkedPdf(source, viewer.user.email, viewer.traceId, viewer.openedAt);
  const refreshed = await prisma.noteViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { pageCount: rendered.pageCount, lastSeenAt: new Date() } });
  const content = { ...rendered, fileName: viewer.contentItem.name, mimeType: "application/pdf", expiresAt: viewer.expiresAt };
  // A user can leave while an eagerly started render is still finishing.
  // Do not retain that completed buffer once the viewer session is closed.
  if (refreshed.count > 0) protectedPdfCache.set(viewer.id, { expiresAt: viewer.expiresAt, content });
  return content;
}

async function renderViewerContent(viewer: Awaited<ReturnType<typeof requireViewerSession>>) {
  const mimeType = viewer.contentItem.mimeType ?? "application/octet-stream";
  if (mimeType !== "application/pdf") return renderViewerContentUncached(viewer);

  const cached = protectedPdfCache.get(viewer.id);
  if (cached && cached.expiresAt > new Date()) {
    await prisma.noteViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { lastSeenAt: new Date() } });
    return cached.content;
  }
  if (cached) protectedPdfCache.delete(viewer.id);

  // Native PDF renderers commonly issue several overlapping byte-range
  // requests while opening a document. Without sharing this promise, every
  // request independently downloads the full R2 object and repeats the costly
  // PDF parse/watermark/save pass before the first one can populate the cache.
  const existingRender = protectedPdfRenderInFlight.get(viewer.id);
  if (existingRender) return existingRender;

  const render = renderViewerContentUncached(viewer);
  protectedPdfRenderInFlight.set(viewer.id, render);
  try {
    return await render;
  } finally {
    if (protectedPdfRenderInFlight.get(viewer.id) === render) protectedPdfRenderInFlight.delete(viewer.id);
  }
}

export async function getViewerContent(userId: string, userSessionId: string, viewerSessionId: string) {
  return renderViewerContent(await requireViewerSession(userId, userSessionId, viewerSessionId));
}

export async function getViewerContentByTicket(viewerSessionId: string, ticket: string) {
  return renderViewerContent(await requireViewerTicket(viewerSessionId, ticket));
}

async function streamViewerContent(viewer: Awaited<ReturnType<typeof requireViewerTicket>>, range?: string) {
  const mimeType = viewer.contentItem.mimeType ?? "application/octet-stream";
  if (mimeType === "application/pdf") throw badRequest("PDF_STREAM_UNSUPPORTED", "Protected PDFs must use the watermarked renderer.");
  if (!viewer.contentItem.storagePath) throw notFound("NOTE_NOT_FOUND", "The note source is unavailable.");
  const signedUrl = await getStorageProvider().createDownloadUrl(viewer.contentItem.storagePath, 60);
  let response: Response;
  try {
    response = await fetch(signedUrl, { headers: { accept: mimeType, ...(range ? { range } : {}) } });
  } catch {
    throw serviceUnavailable("NOTE_SOURCE_UNAVAILABLE", "The protected note source is temporarily unavailable.");
  }
  if (!response.ok) throw serviceUnavailable("NOTE_SOURCE_UNAVAILABLE", "The protected note source is temporarily unavailable.");
  await prisma.noteViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE" }, data: { pageCount: 1, lastSeenAt: new Date() } });
  return { response, fileName: viewer.contentItem.name, mimeType, expiresAt: viewer.expiresAt };
}

export async function getViewerStreamByTicket(viewerSessionId: string, ticket: string, range?: string) {
  return streamViewerContent(await requireViewerTicket(viewerSessionId, ticket), range);
}

export async function getViewerResponseByTicket(viewerSessionId: string, ticket: string, range?: string) {
  const viewer = await requireViewerTicket(viewerSessionId, ticket);
  const mimeType = viewer.contentItem.mimeType ?? "application/octet-stream";
  if (mimeType === "application/pdf") {
    return { kind: "buffer" as const, content: await renderViewerContent(viewer) };
  }
  return { kind: "stream" as const, content: await streamViewerContent(viewer, range) };
}

export async function authorizeViewerTicket(viewerSessionId: string, ticket: string, expectedMimeType?: string) {
  const viewer = await requireViewerTicket(viewerSessionId, ticket);
  if (expectedMimeType && viewer.contentItem.mimeType !== expectedMimeType) throw notFound("NOTE_NOT_FOUND", "The protected note format does not match this viewer.");
  return { id: viewer.id, title: viewer.contentItem.name, mimeType: viewer.contentItem.mimeType, expiresAt: viewer.expiresAt };
}

export async function updateViewerProgress(userId: string, userSessionId: string, viewerSessionId: string, input: { currentPage?: number; progressPercent: number; scrollOffset?: number }) {
  const viewer = await requireViewerSession(userId, userSessionId, viewerSessionId);
  if (viewer.pageCount && input.currentPage && input.currentPage > viewer.pageCount) throw badRequest("INVALID_READING_POSITION", "The current page exceeds the document page count.");
  await prisma.noteViewerSession.update({
    where: { id: viewer.id },
    data: { currentPage: input.currentPage, scrollOffset: input.scrollOffset, lastSeenAt: new Date() },
  });
  await prisma.noteViewerSession.updateMany({ where: { id: viewer.id, status: "ACTIVE", progressPercent: { lt: input.progressPercent } }, data: { progressPercent: input.progressPercent } });
  await recordReadingProgress(userId, viewer.contentItemId, input);
  return prisma.noteViewerSession.findUniqueOrThrow({ where: { id: viewer.id }, select: { id: true, currentPage: true, progressPercent: true, scrollOffset: true, lastSeenAt: true } });
}

export async function heartbeatViewerSession(userId: string, userSessionId: string, viewerSessionId: string) {
  const viewer = await requireViewerSession(userId, userSessionId, viewerSessionId);
  const now = new Date();
  const ttlExpiry = new Date(now.getTime() + VIEWER_TTL_MS);
  const expiresAt = viewer.resourceExpiresAt && viewer.resourceExpiresAt < ttlExpiry ? viewer.resourceExpiresAt : ttlExpiry;
  await prisma.noteViewerSession.update({ where: { id: viewer.id }, data: { lastSeenAt: now, expiresAt } });
  return { viewerSessionId: viewer.id, expiresAt };
}

export async function closeViewerSession(userId: string, userSessionId: string, viewerSessionId: string) {
  const viewer = await prisma.noteViewerSession.findFirst({ where: { id: viewerSessionId, userId, userSessionId }, select: { id: true, status: true } });
  if (!viewer) throw notFound("VIEWER_SESSION_NOT_FOUND", "The protected viewer session was not found.");
  const now = new Date();
  if (viewer.status === "ACTIVE") await prisma.noteViewerSession.update({ where: { id: viewer.id }, data: { status: "CLOSED", closedAt: now, lastSeenAt: now } });
  protectedPdfCache.delete(viewer.id);
  protectedPdfRenderInFlight.delete(viewer.id);
}

export function safeInlineFileName(value: string, mimeType = "application/pdf") {
  const fallbackExtension = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".pdf";
  const normalized = value.replace(/[\r\n"\\/]/g, "_").trim().slice(0, 160) || `protected-note${fallbackExtension}`;
  return /\.[a-z0-9]{2,5}$/i.test(normalized) ? normalized : `${normalized}${fallbackExtension}`;
}
