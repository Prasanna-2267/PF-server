import "dotenv/config";
import { createHash } from "node:crypto";
import { R2Service } from "../services/r2Service.js";
import { getStorageProvider } from "../integrations/provider-registry.js";

async function main() {
  console.log("Testing real binary payload upload and verification...");
  const samplePayload = Buffer.from("Parallax Flow Real File Content Payload Verification 2026");
  const realSha256 = createHash("sha256").update(samplePayload).digest("hex");
  const sizeBytes = samplePayload.length;

  console.log("Payload Size:", sizeBytes, "bytes");
  console.log("Calculated SHA-256:", realSha256);

  console.log("\nGenerating upload intent...");
  const intent = await R2Service.generateUploadPresignedUrl({
    courseId: "c1a2b3c4-d5e6-7890-1234-567890abcdef",
    fileName: "real-binary-test.txt",
    mimeType: "text/plain",
    sizeBytes,
    checksumSha256: realSha256,
  });

  console.log("Object Key:", intent.objectKey);
  console.log("Uploading real payload via PUT...");
  const blob = new Blob([samplePayload], { type: "text/plain" });
  const putResponse = await fetch(intent.uploadUrl, {
    method: "PUT",
    headers: intent.headers,
    body: blob,
  });

  console.log("PUT Status:", putResponse.status, putResponse.statusText);
  if (!putResponse.ok) {
    const errorText = await putResponse.text();
    console.error("PUT Failed:", errorText);
    return;
  }

  console.log("Verifying object via statObject...");
  const provider = getStorageProvider();
  try {
    const stat = await provider.statObject(intent.objectKey);
    console.log("Verified Stat:", stat);
  } catch (err) {
    console.error("RAW statObject error:", err);
  }
}

main().catch(console.error);
