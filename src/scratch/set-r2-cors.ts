import "dotenv/config";
import { createHash, createHmac } from "node:crypto";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");

async function main() {
  const endpoint = process.env.R2_ENDPOINT!;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID!;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;
  const bucketName = process.env.R2_BUCKET_NAME || "parallax-flow-assets";
  const region = process.env.R2_REGION || "auto";
  const allowedOrigins = [...new Set([
    ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ])];
  const originXml = allowedOrigins.map((origin) => `    <AllowedOrigin>${origin.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</AllowedOrigin>`).join("\n");

  const corsXml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
${originXml}
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <AllowedHeader>x-amz-meta-sha256</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-amz-meta-sha256</ExposeHeader>
    <ExposeHeader>Content-Length</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

  const payloadHash = sha256(corsXml);
  const now = new Date();
  const timestamp = amzDate(now);
  const shortDate = timestamp.slice(0, 8);
  const scope = `${shortDate}/${region}/s3/aws4_request`;

  const baseUrl = new URL(endpoint);
  const url = new URL(`/${bucketName}?cors=`, baseUrl);

  const headers: Record<string, string> = {
    host: url.host,
    "content-type": "application/xml",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  };

  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalRequest = [
    "PUT",
    `/${bucketName}`,
    "cors=",
    canonicalHeaders,
    headerNames.join(";"),
    payloadHash,
  ].join("\n");

  const dateKey = hmac(`AWS4${secretAccessKey}`, shortDate);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");

  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  headers["authorization"] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${headerNames.join(";")}, Signature=${signature}`;

  console.log("Sending PUT ?cors request to Cloudflare R2 bucket:", bucketName);
  const response = await fetch(url.toString(), {
    method: "PUT",
    headers,
    body: corsXml,
  });

  console.log("Response Status:", response.status, response.statusText);
  const bodyText = await response.text();
  if (!response.ok) {
    console.error("PUT CORS Error Body:", bodyText);
  } else {
    console.log("SUCCESS! Cloudflare R2 Bucket CORS has been configured!");
  }
}

main().catch(console.error);
