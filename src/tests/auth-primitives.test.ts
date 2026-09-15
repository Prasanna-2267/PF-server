import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { normalizeClientPlatform } from "../auth/types.js";
import {
  createRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  parseRefreshToken,
  refreshTokenMatches,
  verifyAccessToken,
} from "../auth/tokens.js";

const tokenConfig = {
  jwtSecret: "a-test-secret-with-at-least-thirty-two-characters",
  issuer: "test-issuer",
  audience: "test-audience",
  accessTokenTtlSeconds: 900,
};

test("access tokens are signed, scoped, and expire", () => {
  const token = issueAccessToken("user-1", "session-1", tokenConfig, 1_000);
  assert.deepEqual(verifyAccessToken(token, tokenConfig, 1_001), {
    userId: "user-1",
    authSessionId: "session-1",
  });
  assert.throws(() => verifyAccessToken(token, tokenConfig, 1_901));
  assert.throws(() => verifyAccessToken(token, { ...tokenConfig, audience: "other" }, 1_001));

  const parts = token.split(".");
  parts[1] = Buffer.from(JSON.stringify({ sub: "attacker" })).toString("base64url");
  assert.throws(() => verifyAccessToken(parts.join("."), tokenConfig, 1_001));
});

test("access tokens reject malformed, forged, wrong-scope, future, and algorithm-confusion inputs", () => {
  const token = issueAccessToken("user-1", "session-1", tokenConfig, 1_000);
  const [header, claims] = token.split(".");
  const resign = (nextHeader: object, nextClaims: object) => {
    const encodedHeader = Buffer.from(JSON.stringify(nextHeader)).toString("base64url");
    const encodedClaims = Buffer.from(JSON.stringify(nextClaims)).toString("base64url");
    const unsigned = `${encodedHeader}.${encodedClaims}`;
    return `${unsigned}.${createHmac("sha256", tokenConfig.jwtSecret).update(unsigned).digest("base64url")}`;
  };
  const parsedClaims = JSON.parse(Buffer.from(claims!, "base64url").toString("utf8"));

  assert.throws(() => verifyAccessToken("not-a-jwt", tokenConfig, 1_001));
  assert.throws(() => verifyAccessToken(`${header}.${claims}.forged`, tokenConfig, 1_001));
  assert.throws(() => verifyAccessToken(resign({ alg: "none", typ: "JWT" }, parsedClaims), tokenConfig, 1_001));
  assert.throws(() => verifyAccessToken(resign({ alg: "HS256", typ: "JWT" }, { ...parsedClaims, iss: "evil" }), tokenConfig, 1_001));
  assert.throws(() => verifyAccessToken(resign({ alg: "HS256", typ: "JWT" }, { ...parsedClaims, aud: "evil" }), tokenConfig, 1_001));
  assert.throws(() => verifyAccessToken(resign({ alg: "HS256", typ: "JWT" }, { ...parsedClaims, iat: 1_032 }), tokenConfig, 1_001));
  assert.throws(() => verifyAccessToken(`${token}${"x".repeat(4_097)}`, tokenConfig, 1_001));
});

test("refresh tokens are opaque and compared by hash", () => {
  const token = createRefreshToken("session-1");
  const digest = hashRefreshToken(token);
  assert.equal(digest.length, 64);
  assert.equal(refreshTokenMatches(token, digest), true);
  assert.equal(refreshTokenMatches(`${token}x`, digest), false);
  assert.deepEqual(parseRefreshToken(token), { authSessionId: "session-1" });
  assert.throws(() => parseRefreshToken("rt1.session.short"));
  assert.throws(() => parseRefreshToken(`${token}.extra`));
  assert.throws(() => parseRefreshToken("x".repeat(513)));
});

test("password credentials use scrypt and reject an incorrect password", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("incorrect horse battery staple", encoded), false);
});

test("mobile client platform metadata is normalized and unknown values fail closed", () => {
  assert.equal(normalizeClientPlatform("android"), "ANDROID");
  assert.equal(normalizeClientPlatform(" IOS "), "IOS");
  assert.equal(normalizeClientPlatform("WEB"), "WEB");
  assert.equal(normalizeClientPlatform(undefined), "WEB");
  assert.equal(normalizeClientPlatform("smart-fridge"), "UNKNOWN");
});
