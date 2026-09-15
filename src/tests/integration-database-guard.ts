const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TEST_DATABASE_NAME = /(?:^|[_-])(test|testing|ci)(?:$|[_-])/i;

export function assertIntegrationDatabase(flagName: string): string {
  const testUrl = process.env.TEST_DATABASE_URL?.trim();
  const runtimeUrl = process.env.DATABASE_URL?.trim() || process.env.DIRECT_URL?.trim();
  if (process.env[flagName] !== "1") throw new Error(`${flagName}=1 is required for integration database access.`);
  if (!testUrl || !runtimeUrl || testUrl !== runtimeUrl) throw new Error("TEST_DATABASE_URL must be set and exactly match the runtime DATABASE_URL or DIRECT_URL.");
  let parsed: URL;
  try { parsed = new URL(testUrl); } catch { throw new Error("TEST_DATABASE_URL is not a valid URL."); }
  if (!LOCAL_DATABASE_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error("Integration tests only permit a loopback PostgreSQL host; remote and production hosts are blocked.");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!TEST_DATABASE_NAME.test(databaseName)) throw new Error("The integration database name must contain a delimited test, testing, or ci marker.");
  return testUrl;
}

export const integrationDatabaseEnabled = (flagName: string): boolean => {
  try { assertIntegrationDatabase(flagName); return true; } catch { return false; }
};
