import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environmentFile = resolve(repositoryRoot, ".env.local");
const [entrypoint, ...entrypointArguments] = process.argv.slice(2);

if (!entrypoint) {
  throw new Error("A Node.js entrypoint is required.");
}

if (existsSync(environmentFile)) {
  process.loadEnvFile(environmentFile);
}

const child = spawn(
  process.execPath,
  [resolve(process.cwd(), entrypoint), ...entrypointArguments],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
