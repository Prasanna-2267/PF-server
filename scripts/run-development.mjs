import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const children = [
  spawn(process.execPath, [tsxCli, "watch", "src/index.ts"], { stdio: "inherit", env: process.env }),
  spawn(process.execPath, [tsxCli, "watch", "src/jobs/run-durable-worker.ts"], { stdio: "inherit", env: process.env }),
];

let stopping = false;

const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(signal));
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(`[development] Failed to start a required process: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    if (code !== 0) {
      console.error(`[development] A required process stopped (${signal ?? `exit ${code}`}).`);
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
