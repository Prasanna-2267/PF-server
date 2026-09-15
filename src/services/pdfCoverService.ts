import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

export interface GeneratedPdfCover {
  buffer: Buffer;
  mimeType: "image/png";
  fileName: typeof PDF_COVER_FILE_NAME;
  sizeBytes: number;
}

export const PDF_COVER_FILE_NAME = "cover-v2.png" as const;

const installPdfJsCanvasGlobals = () => {
  const target = globalThis as Record<string, any>;
  target.DOMMatrix ??= DOMMatrix;
  target.ImageData ??= ImageData;
  target.Path2D ??= Path2D;
};

/** Render the actual first PDF page. No generated or branded placeholder is used. */
export async function generatePdfFirstPageCover(pdfBuffer: Buffer, _contentTitle = "PDF Document"): Promise<GeneratedPdfCover> {
  installPdfJsCanvasGlobals();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });

  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) throw new Error("PDF contains no pages.");

    const page = await document.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1_000 / Math.max(baseViewport.width, 1));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas: canvas as any,
      canvasContext: context as any,
      viewport,
      background: "#ffffff",
    }).promise;

    const buffer = canvas.toBuffer("image/png");
    return { buffer, mimeType: "image/png", fileName: PDF_COVER_FILE_NAME, sizeBytes: buffer.length };
  } finally {
    await loadingTask.destroy();
  }
}
