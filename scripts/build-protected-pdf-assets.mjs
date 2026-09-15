import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const outputDirectory = resolve(process.cwd(), "assets", "protected-viewer");
await mkdir(outputDirectory, { recursive: true });
const pdfSource = await readFile(resolve(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs"), "utf8");
const workerSource = await readFile(resolve(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"), "utf8");

const shared = {
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["chrome67"],
  legalComments: "none",
};

await Promise.all([
  build({
    ...shared,
    stdin: { contents: pdfSource, loader: "js", resolveDir: process.cwd(), sourcefile: "pdf.mjs" },
    outfile: resolve(outputDirectory, "pdf-classic-v5.min.js"),
    format: "iife",
    globalName: "pdfjsLib",
    platform: "browser",
  }),
  build({
    ...shared,
    stdin: { contents: workerSource, loader: "js", resolveDir: process.cwd(), sourcefile: "pdf.worker.mjs" },
    outfile: resolve(outputDirectory, "pdf-classic-worker-v5.min.js"),
    format: "iife",
    globalName: "pdfjsWorker",
    platform: "browser",
  }),
]);

console.log(`Protected PDF assets built in ${outputDirectory}`);
