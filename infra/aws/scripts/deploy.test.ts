import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "invook-release-commit-"));
const repository = join(root, "repository");
const stubs = join(root, "bin");
const script = join(repository, "infra/aws/scripts/deploy.sh");
const callLog = join(root, "calls.log");
const stackFile = join(root, "stack.json");

function git(...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Release Test", "-c", "user.email=release@example.test", ...args], {
    cwd: repository, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

mkdirSync(join(repository, "infra/aws/scripts"), { recursive: true });
mkdirSync(join(repository, "apps/api"), { recursive: true });
mkdirSync(stubs);
copyFileSync(new URL("./deploy.sh", import.meta.url), script);
chmodSync(script, 0o755);
// The readiness check imports the API's own axios, as it does in a checkout.
symlinkSync(fileURLToPath(new URL("../../../apps/api/node_modules", import.meta.url)), join(repository, "apps/api/node_modules"));
git("init", "--quiet");
git("commit", "--quiet", "--allow-empty", "-m", "Older release");
const olderCommit = git("rev-parse", "HEAD");
git("commit", "--quiet", "--allow-empty", "-m", "Newer release");
const newerCommit = git("rev-parse", "HEAD");

// AWS answers stack reads and the services wait; any other call is logged and
// fails, which ends a release that was not skipped right after it starts publishing.
for (const [name, body] of [
  ["aws", [
    'echo "aws $*" >> "$CALL_LOG"',
    'for argument in "$@"; do',
    '  [[ "$argument" == describe-stacks ]] && exec cat "$STACK_FILE"',
    '  [[ "$argument" == services-stable ]] && exit "$SERVICES_STABLE_STATUS"',
    "done",
    "exit 1",
  ].join("\n")],
  ["docker", 'echo "docker $*" >> "$CALL_LOG"\nexit 1'],
]) {
  writeFileSync(join(stubs, name), "#!/usr/bin/env bash\n" + body + "\n", { mode: 0o755 });
}

let readinessStatus = 200;
const readiness = createServer((request, response) => {
  response.writeHead(request.url === "/health/ready" ? readinessStatus : 404).end();
});
let apiUrl = "";

before(async () => {
  await new Promise<void>((resolve) => readiness.listen(0, "127.0.0.1", resolve));
  const address = readiness.address();
  assert.ok(address !== null && typeof address === "object");
  apiUrl = "http://127.0.0.1:" + address.port;
});

after(async () => {
  await new Promise<void>((resolve) => readiness.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

interface Production {
  image: string;
  apiCount: string;
  areServicesStable?: boolean;
  readyStatus?: number;
}

async function releaseCommit(commit: string, production: Production) {
  readinessStatus = production.readyStatus ?? 200;
  writeFileSync(callLog, "");
  writeFileSync(stackFile, JSON.stringify({ Stacks: [{
    Parameters: [
      { ParameterKey: "ApiImage", ParameterValue: production.image },
      { ParameterKey: "ApiCount", ParameterValue: production.apiCount },
    ],
    Outputs: [
      { OutputKey: "ApiRepository", OutputValue: "123456789012.dkr.ecr.ap-south-1.amazonaws.com/invookemail-prod/api" },
      { OutputKey: "WorkerRepository", OutputValue: "123456789012.dkr.ecr.ap-south-1.amazonaws.com/invookemail-prod/worker" },
      { OutputKey: "Cluster", OutputValue: "invookemail-prod" },
      { OutputKey: "ApiUrl", OutputValue: apiUrl },
    ],
  }] }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "AWS_PROFILE"));
  const child = spawn("bash", [script, "release-commit", commit], {
    cwd: repository,
    env: {
      ...inherited, PATH: stubs + ":" + process.env.PATH, AWS_REGION: "ap-south-1",
      CALL_LOG: callLog, STACK_FILE: stackFile,
      SERVICES_STABLE_STATUS: production.areServicesStable === false ? "255" : "0",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const calls = readFileSync(callLog, "utf8");
  return {
    status, stdout, stderr,
    didCheckHealth: calls.includes("services-stable"),
    didPublish: calls.includes("ecr get-login-password"),
  };
}

const image = (tag: string) => "123456789012.dkr.ecr.ap-south-1.amazonaws.com/invookemail-prod/api:" + tag;

test("an older commit never replaces a newer release that already contains it", async () => {
  const stale = await releaseCommit(olderCommit, { image: image(newerCommit), apiCount: "1" });
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, new RegExp("Production already runs " + newerCommit));
  assert.equal(stale.didPublish, false);
});

test("the same commit counts as released only while its services run and the API is ready", async () => {
  const healthy = await releaseCommit(newerCommit, { image: image(newerCommit), apiCount: "1" });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /is ready/);
  assert.equal(healthy.didCheckHealth, true);
  assert.equal(healthy.didPublish, false);

  // An earlier attempt that failed its final checks, or stopped before starting
  // the services, is released again instead of reported as done.
  for (const production of [
    { image: image(newerCommit), apiCount: "1", readyStatus: 503 },
    { image: image(newerCommit), apiCount: "1", areServicesStable: false },
    { image: image(newerCommit), apiCount: "0" },
  ]) {
    assert.equal((await releaseCommit(newerCommit, production)).didPublish, true, JSON.stringify(production));
  }
});

test("a newer commit, or one production cannot place in history, is released", async () => {
  for (const production of [
    { image: image(olderCommit), apiCount: "1" },
    { image: image("dc3a879-20261018190000"), apiCount: "1" },
    { image: "", apiCount: "0" },
  ]) {
    assert.equal((await releaseCommit(newerCommit, production)).didPublish, true, JSON.stringify(production));
  }
});

test("only a full commit SHA can be released", async () => {
  const result = await releaseCommit(newerCommit.slice(0, 7), { image: "", apiCount: "0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /full commit SHA/);
  assert.equal(result.didPublish, false);
});
