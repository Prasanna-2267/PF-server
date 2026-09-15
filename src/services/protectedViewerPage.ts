import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

export const pdfJsModulePath = require.resolve("pdfjs-dist/build/pdf.min.mjs");
export const pdfJsWorkerPath = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs");
export const pdfJsLegacyModulePath = require.resolve("pdfjs-dist/legacy/build/pdf.min.mjs");
export const pdfJsLegacyWorkerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
export const pdfJsClassicPath = resolve(process.cwd(), "assets", "protected-viewer", "pdf-classic-v5.min.js");
export const pdfJsClassicWorkerPath = resolve(process.cwd(), "assets", "protected-viewer", "pdf-classic-worker-v5.min.js");

export const protectedPdfViewerBootstrap = String.raw`
(function () {
  const timeout = window.setTimeout(function () {
    const status = document.getElementById("status");
    const title = document.getElementById("status-title");
    const copy = document.getElementById("status-copy");
    const retry = document.getElementById("retry");
    if (title) title.textContent = "Unable to start the PDF viewer";
    if (copy) copy.textContent = "Please reopen the note and try again.";
    if (retry) retry.hidden = false;
    if (status) status.hidden = false;
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "error", message: "The protected PDF viewer could not start on this device." }));
  }, 30000);
  window.addEventListener("pf-pdf-viewer-started", function () { window.clearTimeout(timeout); }, { once: true });
})();
`;

export const protectedPdfViewerScript = String.raw`
(function () {
const pdfjsLib = globalThis.pdfjsLib;
if (!pdfjsLib || typeof pdfjsLib.getDocument !== "function") {
  throw new Error("The protected PDF engine did not load.");
}

dispatchEvent(new Event("pf-pdf-viewer-started"));
pdfjsLib.GlobalWorkerOptions.workerSrc = "/api/protected-viewer/assets/pdf-classic-worker-v5.min.js";

const pages = document.getElementById("pages");
const status = document.getElementById("status");
const statusTitle = document.getElementById("status-title");
const statusCopy = document.getElementById("status-copy");
const retry = document.getElementById("retry");
const match = location.pathname.match(/\/api\/protected-viewer\/([0-9a-f-]+)\/view$/i);
const ticket = new URLSearchParams(location.search).get("ticket");

function send(message) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
}

function fail(error) {
  const message = error instanceof Error ? error.message : "The protected PDF could not be rendered.";
  statusTitle.textContent = "Unable to open this PDF";
  statusCopy.textContent = "Please reopen the note and try again.";
  retry.hidden = false;
  status.hidden = false;
  send({ type: "error", message });
}

async function renderPage(documentTask, pageNumber) {
  const page = await documentTask.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const availableWidth = Math.min(Math.max(document.documentElement.clientWidth - 20, 280), 960);
  const viewport = page.getViewport({ scale: availableWidth / base.width });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
  const shell = document.createElement("section");
  shell.className = "page";
  shell.setAttribute("aria-label", "Page " + pageNumber);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = Math.floor(viewport.width) + "px";
  canvas.style.height = Math.floor(viewport.height) + "px";
  shell.appendChild(canvas);
  pages.appendChild(shell);
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
  page.cleanup();
}

async function start() {
  if (!match || !ticket) throw new Error("The protected viewer link is incomplete.");
  const contentUrl = location.pathname.replace(/\/view$/, "/content") + "?ticket=" + encodeURIComponent(ticket);
  const documentTask = await pdfjsLib.getDocument({ url: contentUrl, disableRange: false, disableStream: false, isEvalSupported: false }).promise;
  send({ type: "loaded", pages: documentTask.numPages });
  for (let pageNumber = 1; pageNumber <= documentTask.numPages; pageNumber += 1) {
    statusCopy.textContent = "Preparing page " + pageNumber + " of " + documentTask.numPages + "…";
    await renderPage(documentTask, pageNumber);
    if (pageNumber === 1) status.hidden = true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

let progressFrame = 0;
addEventListener("scroll", () => {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    const maximum = Math.max(document.documentElement.scrollHeight - innerHeight, 1);
    send({ type: "progress", progressPercent: Math.max(1, Math.min(100, Math.round((scrollY / maximum) * 100))), scrollOffset: Math.round(scrollY) });
  });
}, { passive: true });

addEventListener("contextmenu", (event) => event.preventDefault());
addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && ["p", "s"].includes(event.key.toLowerCase())) event.preventDefault();
});
retry.addEventListener("click", () => location.reload());
start().catch(fail);
})();
`;

export const protectedPdfViewerHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=5,user-scalable=yes,viewport-fit=cover" />
  <title>Protected PDF</title>
  <style>
    :root { color-scheme: dark; background: #090b0d; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { min-height: 100%; margin: 0; background: #090b0d; overscroll-behavior: none; }
    body { padding: 10px 10px 28px; user-select: none; -webkit-user-select: none; }
    #pages { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .page { max-width: 960px; overflow: hidden; background: white; box-shadow: 0 8px 26px rgba(0,0,0,.32); }
    canvas { display: block; max-width: 100%; height: auto; }
    #status { position: fixed; inset: 0; z-index: 10; display: grid; place-content: center; gap: 10px; padding: 28px; text-align: center; background: #090b0d; }
    #status[hidden] { display: none; }
    .spinner { width: 34px; height: 34px; margin: 0 auto 8px; border: 3px solid #26314f; border-top-color: #7c9cff; border-radius: 50%; animation: spin .8s linear infinite; }
    h1 { margin: 0; color: #f4f6fa; font-size: 17px; }
    p { max-width: 300px; margin: 0; color: #a2a9b2; font-size: 12px; line-height: 18px; }
    button { justify-self: center; margin-top: 8px; padding: 10px 18px; border: 1px solid #506fcf; border-radius: 999px; color: #dce5ff; background: #18213d; font: inherit; font-weight: 700; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main id="pages" aria-live="polite"></main>
  <section id="status"><div class="spinner"></div><h1 id="status-title">Opening protected PDF</h1><p id="status-copy">Preparing the document…</p><button id="retry" type="button" hidden>Try again</button></section>
  <script src="/api/protected-viewer/assets/pdf-viewer-bootstrap-v3.js"></script>
  <script src="/api/protected-viewer/assets/pdf-classic-v5.min.js"></script>
  <script src="/api/protected-viewer/assets/pdf-classic-worker-v5.min.js"></script>
  <script src="/api/protected-viewer/assets/pdf-viewer-v3.js"></script>
</body>
</html>`;

const htmlAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const protectedFileViewerScript = String.raw`
const root = document.getElementById("root");
const status = document.getElementById("status");
const mime = document.body.dataset.mime || "application/octet-stream";
const title = document.body.dataset.title || "Protected file";
const ticket = new URLSearchParams(location.search).get("ticket");
const contentUrl = location.pathname.replace(/\/file-view$/, "/content") + "?ticket=" + encodeURIComponent(ticket || "");

function send(message) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
}

function ready() {
  status.hidden = true;
  send({ type: "loaded", pages: 1 });
}

function fail() {
  status.querySelector("h1").textContent = "Unable to open this file";
  status.querySelector("p").textContent = "Please reopen the file and try again.";
  status.hidden = false;
  send({ type: "error", message: "The protected file could not be rendered." });
}

async function start() {
  if (!ticket) throw new Error("Missing viewer ticket");
  if (mime.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = contentUrl; video.controls = true; video.autoplay = false; video.playsInline = true;
    video.setAttribute("controlsList", "nodownload noplaybackrate"); video.disablePictureInPicture = true;
    video.addEventListener("loadedmetadata", ready, { once: true }); video.addEventListener("error", fail, { once: true }); root.appendChild(video); return;
  }
  if (mime.startsWith("audio/")) {
    const shell = document.createElement("section"); shell.className = "audio-shell";
    const heading = document.createElement("h2"); heading.textContent = title;
    const audio = document.createElement("audio"); audio.src = contentUrl; audio.controls = true; audio.setAttribute("controlsList", "nodownload noplaybackrate");
    audio.addEventListener("loadedmetadata", ready, { once: true }); audio.addEventListener("error", fail, { once: true }); shell.append(heading, audio); root.appendChild(shell); return;
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    const response = await fetch(contentUrl); if (!response.ok) throw new Error("HTTP " + response.status);
    const pre = document.createElement("pre"); pre.textContent = await response.text(); root.appendChild(pre); ready(); return;
  }
  const shell = document.createElement("section"); shell.className = "format-shell";
  const badge = document.createElement("div"); badge.className = "format-badge"; badge.textContent = title.split(".").pop()?.toUpperCase() || "FILE";
  const heading = document.createElement("h2"); heading.textContent = title;
  const copy = document.createElement("p"); copy.textContent = "This file is available in your course. Its format cannot be rendered safely inside the protected viewer; downloads remain disabled.";
  shell.append(badge, heading, copy); root.appendChild(shell); ready();
}

addEventListener("contextmenu", (event) => event.preventDefault());
start().catch(fail);
`;

export function protectedFileViewerHtml(mimeType: string, title: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4,user-scalable=yes,viewport-fit=cover"/><title>Protected file</title><style>
  :root{color-scheme:dark;background:#090b0d;font-family:system-ui,sans-serif}*{box-sizing:border-box}html,body,#root{min-height:100%;margin:0;background:#090b0d}body{user-select:none;-webkit-user-select:none}#root{display:grid;place-items:center;padding:18px}video{width:100%;max-height:82vh;background:#050607;border-radius:14px}audio{width:min(100%,520px)}pre{width:100%;min-height:calc(100vh - 36px);margin:0;padding:20px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid #252b31;border-radius:16px;color:#e9edf2;background:#111519;font:13px/1.65 ui-monospace,monospace}.audio-shell,.format-shell{width:min(100%,520px);padding:26px;border:1px solid #252b31;border-radius:20px;text-align:center;background:#111519}.format-badge{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 18px;border-radius:18px;color:#ffca61;background:#302612;font-weight:800}h2{margin:0;color:#f4f6fa;font-size:19px}p{margin:10px auto 0;max-width:390px;color:#a2a9b2;font-size:13px;line-height:1.6}#status{position:fixed;inset:0;z-index:5;display:grid;place-content:center;padding:28px;text-align:center;background:#090b0d}#status[hidden]{display:none}#status h1{margin:0;color:#f4f6fa;font-size:17px}#status p{font-size:12px}
  </style></head><body data-mime="${htmlAttribute(mimeType)}" data-title="${htmlAttribute(title)}"><main id="root"></main><section id="status"><h1>Opening protected file</h1><p>Preparing the content…</p></section><script type="module" src="/api/protected-viewer/assets/file-viewer.mjs"></script></body></html>`;
}
