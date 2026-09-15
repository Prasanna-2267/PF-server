import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { unauthorized } from "../errors/api-error.js";

export interface TokenConfiguration {
  jwtSecret: string;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
}

interface AccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  jti: string;
  typ: "access";
  iat: number;
  exp: number;
}

const encodeJson = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const sign = (unsignedToken: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(unsignedToken).digest();

export const issueAccessToken = (
  userId: string,
  authSessionId: string,
  config: TokenConfiguration,
  nowSeconds = Math.floor(Date.now() / 1000),
): string => {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const claims: AccessTokenClaims = {
    iss: config.issuer,
    aud: config.audience,
    sub: userId,
    sid: authSessionId,
    jti: randomUUID(),
    typ: "access",
    iat: nowSeconds,
    exp: nowSeconds + config.accessTokenTtlSeconds,
  };
  const unsignedToken = `${header}.${encodeJson(claims)}`;
  return `${unsignedToken}.${sign(unsignedToken, config.jwtSecret).toString("base64url")}`;
};

const readObject = (encoded: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid token object");
    return parsed as Record<string, unknown>;
  } catch {
    throw unauthorized("The access token is invalid or expired.");
  }
};

export const verifyAccessToken = (
  token: string,
  config: TokenConfiguration,
  nowSeconds = Math.floor(Date.now() / 1000),
): { userId: string; authSessionId: string } => {
  if (token.length > 4_096) throw unauthorized("The access token is invalid or expired.");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw unauthorized("The access token is invalid or expired.");

  const header = readObject(parts[0]!);
  if (header.alg !== "HS256" || header.typ !== "JWT") throw unauthorized("The access token is invalid or expired.");

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(parts[2]!, "base64url");
  } catch {
    throw unauthorized("The access token is invalid or expired.");
  }
  const expectedSignature = sign(`${parts[0]}.${parts[1]}`, config.jwtSecret);
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw unauthorized("The access token is invalid or expired.");
  }

  const claims = readObject(parts[1]!);
  const valid =
    claims.typ === "access" &&
    claims.iss === config.issuer &&
    claims.aud === config.audience &&
    typeof claims.sub === "string" &&
    typeof claims.sid === "string" &&
    typeof claims.iat === "number" &&
    typeof claims.exp === "number" &&
    claims.iat <= nowSeconds + 30 &&
    claims.exp > nowSeconds;
  if (!valid) throw unauthorized("The access token is invalid or expired.");

  return { userId: claims.sub as string, authSessionId: claims.sid as string };
};

export const createRefreshToken = (authSessionId: string): string =>
  `rt1.${authSessionId}.${randomBytes(32).toString("base64url")}`;

export const parseRefreshToken = (token: string): { authSessionId: string } => {
  if (token.length > 512) throw unauthorized("The refresh token is invalid or expired.");
  const [version, authSessionId, secret, extra] = token.split(".");
  if (version !== "rt1" || !authSessionId || !secret || extra || secret.length < 40) {
    throw unauthorized("The refresh token is invalid or expired.");
  }
  return { authSessionId };
};

export const hashRefreshToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const refreshTokenMatches = (token: string, expectedHash: string | null): boolean => {
  if (!expectedHash || expectedHash.length !== 64) return false;
  const actual = Buffer.from(hashRefreshToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
