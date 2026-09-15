import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { badRequest } from "../errors/api-error.js";

const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 96 * 1024 * 1024;

const deriveKey = (password: string, salt: Buffer, cost = SCRYPT_COST): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: cost, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION, maxmem: MAX_MEMORY },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });

export const assertPasswordPolicy = (password: string): void => {
  if (password.length < 12 || password.length > 128) {
    throw badRequest("PASSWORD_POLICY_FAILED", "Password must contain between 12 and 128 characters.", {
      password: ["Use between 12 and 128 characters."],
    });
  }
};

export const hashPassword = async (password: string): Promise<string> => {
  assertPasswordPolicy(password);
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt);
  return [
    "scrypt",
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
};

export const verifyPassword = async (password: string, encodedHash: string): Promise<boolean> => {
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    await deriveKey(password, Buffer.alloc(16));
    return false;
  }

  const [cost, blockSize, parallelization] = parts.slice(1, 4).map(Number);
  if (cost !== SCRYPT_COST || blockSize !== SCRYPT_BLOCK_SIZE || parallelization !== SCRYPT_PARALLELIZATION) {
    await deriveKey(password, Buffer.alloc(16));
    return false;
  }

  try {
    const salt = Buffer.from(parts[4]!, "base64url");
    const expected = Buffer.from(parts[5]!, "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = await deriveKey(password, salt, cost);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

export const consumePasswordVerificationWork = async (password: string): Promise<void> => {
  await deriveKey(password, Buffer.alloc(16));
};
