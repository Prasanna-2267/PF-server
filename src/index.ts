import "dotenv/config";
import { startServer } from "./app/server.js";

startServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "server.startup_failed", errorMessage: message }));
  process.exitCode = 1;
});

