import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/async-route.js";
import * as viewer from "../services/protectedViewerService.js";
import { pdfJsClassicPath, pdfJsClassicWorkerPath, pdfJsLegacyModulePath, pdfJsLegacyWorkerPath, pdfJsModulePath, pdfJsWorkerPath, protectedFileViewerHtml, protectedFileViewerScript, protectedPdfViewerBootstrap, protectedPdfViewerHtml, protectedPdfViewerScript } from "../services/protectedViewerPage.js";

const uuid = z.string().uuid();
const ticketSchema = z.string().regex(/^[a-f0-9]{24}$/i);

export const protectedViewerRouter = Router();

protectedViewerRouter.get("/assets/pdf.min.mjs", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/javascript; charset=utf-8" });
  res.sendFile(pdfJsModulePath);
});

protectedViewerRouter.get("/assets/pdf.worker.min.mjs", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/javascript; charset=utf-8" });
  res.sendFile(pdfJsWorkerPath);
});

protectedViewerRouter.get("/assets/pdf-legacy.min.mjs", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/javascript; charset=utf-8" });
  res.sendFile(pdfJsLegacyModulePath);
});

protectedViewerRouter.get("/assets/pdf-legacy.worker.min.mjs", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/javascript; charset=utf-8" });
  res.sendFile(pdfJsLegacyWorkerPath);
});

protectedViewerRouter.get("/assets/pdf-classic-v5.min.js", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/javascript; charset=utf-8" });
  res.sendFile(pdfJsClassicPath);
});

protectedViewerRouter.get("/assets/pdf-classic-worker-v5.min.js", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/javascript; charset=utf-8" });
  res.sendFile(pdfJsClassicWorkerPath);
});

protectedViewerRouter.get("/assets/pdf-viewer.mjs", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=3600", "Content-Type": "text/javascript; charset=utf-8" });
  res.send(protectedPdfViewerScript);
});

protectedViewerRouter.get("/assets/pdf-viewer-bootstrap-v2.js", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=3600", "Content-Type": "text/javascript; charset=utf-8" });
  res.send(protectedPdfViewerBootstrap);
});

protectedViewerRouter.get("/assets/pdf-viewer-bootstrap-v3.js", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=3600", "Content-Type": "text/javascript; charset=utf-8" });
  res.send(protectedPdfViewerBootstrap);
});

protectedViewerRouter.get("/assets/pdf-viewer-v2.mjs", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=3600", "Content-Type": "text/javascript; charset=utf-8" });
  res.send(protectedPdfViewerScript);
});

protectedViewerRouter.get("/assets/pdf-viewer-v3.js", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=3600", "Content-Type": "text/javascript; charset=utf-8" });
  res.send(protectedPdfViewerScript);
});

protectedViewerRouter.get("/assets/file-viewer.mjs", (_req, res) => {
  res.set({ "Cache-Control": "public, max-age=3600", "Content-Type": "text/javascript; charset=utf-8" });
  res.send(protectedFileViewerScript);
});

protectedViewerRouter.get("/:viewerSessionId/view", asyncRoute(async (req, res) => {
  const viewerSessionId = uuid.parse(req.params.viewerSessionId);
  const ticket = ticketSchema.parse(req.query.ticket);
  await viewer.authorizeViewerTicket(viewerSessionId, ticket, "application/pdf");
  res.set({
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Protected-Viewer": "true",
  });
  res.send(protectedPdfViewerHtml);
}));

protectedViewerRouter.get("/:viewerSessionId/file-view", asyncRoute(async (req, res) => {
  const viewerSessionId = uuid.parse(req.params.viewerSessionId);
  const ticket = ticketSchema.parse(req.query.ticket);
  const authorised = await viewer.authorizeViewerTicket(viewerSessionId, ticket);
  res.set({
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; media-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:",
    "X-Content-Type-Options": "nosniff",
    "X-Protected-Viewer": "true",
  });
  res.send(protectedFileViewerHtml(authorised.mimeType ?? "application/octet-stream", authorised.title));
}));

// Native Android image/PDF loaders may omit custom Authorization headers.
// The opaque ticket is bound to one active viewer session, login session and TTL.
protectedViewerRouter.get("/:viewerSessionId/content", asyncRoute(async (req, res) => {
  const viewerSessionId = uuid.parse(req.params.viewerSessionId);
  const ticket = ticketSchema.parse(req.query.ticket);
  const rangeHeader = req.get("range") ?? undefined;
  const resolved = await viewer.getViewerResponseByTicket(viewerSessionId, ticket, rangeHeader);
  if (resolved.kind === "stream") {
    const content = resolved.content;
    const upstream = content.response;
    const headers: Record<string, string> = {
      "Accept-Ranges": upstream.headers.get("accept-ranges") ?? "bytes",
      "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Type": content.mimeType,
      "Content-Disposition": `inline; filename="${viewer.safeInlineFileName(content.fileName, content.mimeType)}"`,
      "X-Content-Type-Options": "nosniff",
      "X-Protected-Viewer": "true",
    };
    for (const name of ["content-length", "content-range"] as const) {
      const value = upstream.headers.get(name);
      if (value) headers[name === "content-length" ? "Content-Length" : "Content-Range"] = value;
    }
    res.status(upstream.status).set(headers);
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    try {
      while (!res.destroyed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!res.write(Buffer.from(chunk.value))) await new Promise<void>((resolve) => {
          const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
          res.once("drain", done);
          res.once("close", done);
        });
      }
    } finally {
      if (res.destroyed) await reader.cancel().catch(() => undefined);
      else { reader.releaseLock(); res.end(); }
    }
    return;
  }
  const content = resolved.content;
  const total = content.buffer.length;
  let start = 0;
  let end = total - 1;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) { res.status(416).set("Content-Range", `bytes */${total}`).end(); return; }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) { const suffixLength = Number(match[2]); start = Math.max(0, total - suffixLength); end = total - 1; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) { res.status(416).set("Content-Range", `bytes */${total}`).end(); return; }
    end = Math.min(end, total - 1);
  }
  const body = content.buffer.subarray(start, end + 1);
  res.status(rangeHeader ? 206 : 200);
  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Type": content.mimeType,
    "Content-Length": String(body.length),
    "Content-Disposition": `inline; filename="${viewer.safeInlineFileName(content.fileName, content.mimeType)}"`,
    "X-Content-Type-Options": "nosniff",
    "X-Protected-Viewer": "true",
  });
  if (rangeHeader) res.set("Content-Range", `bytes ${start}-${end}/${total}`);
  res.end(body);
}));
