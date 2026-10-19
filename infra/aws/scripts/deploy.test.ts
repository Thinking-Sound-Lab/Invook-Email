import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

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
mkdirSync(stubs);
copyFileSync(new URL("./deploy.sh", import.meta.url), script);
chmodSync(script, 0o755);
git("init", "--quiet");
git("commit", "--quiet", "--allow-empty", "-m", "Older release");
const olderCommit = git("rev-parse", "HEAD");
git("commit", "--quiet", "--allow-empty", "-m", "Newer release");
const newerCommit = git("rev-parse", "HEAD");

// AWS answers only stack reads; any write or registry call is logged and fails,
// which ends a release that was not skipped right after it starts publishing.
for (const [name, body] of [
  ["aws", 'echo "aws $*" >> "$CALL_LOG"\nfor argument in "$@"; do [[ "$argument" == describe-stacks ]] && exec cat "$STACK_FILE"; done\nexit 1'],
  ["docker", 'echo "docker $*" >> "$CALL_LOG"\nexit 1'],
]) {
  writeFileSync(join(stubs, name), "#!/usr/bin/env bash\n" + body + "\n", { mode: 0o755 });
}

after(() => rmSync(root, { recursive: true, force: true }));

function releaseCommit(commit: string, deployed: { image: string; apiCount: string }) {
  writeFileSync(callLog, "");
  writeFileSync(stackFile, JSON.stringify({ Stacks: [{
    Parameters: [
      { ParameterKey: "ApiImage", ParameterValue: deployed.image },
      { ParameterKey: "ApiCount", ParameterValue: deployed.apiCount },
    ],
    Outputs: [
      { OutputKey: "ApiRepository", OutputValue: "123456789012.dkr.ecr.ap-south-1.amazonaws.com/invookemail-prod/api" },
      { OutputKey: "WorkerRepository", OutputValue: "123456789012.dkr.ecr.ap-south-1.amazonaws.com/invookemail-prod/worker" },
    ],
  }] }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "AWS_PROFILE"));
  const environment = { ...inherited, PATH: stubs + ":" + process.env.PATH, AWS_REGION: "ap-south-1", CALL_LOG: callLog, STACK_FILE: stackFile };
  const result = spawnSync("bash", [script, "release-commit", commit], { cwd: repository, encoding: "utf8", env: environment });
  return { ...result, didPublish: readFileSync(callLog, "utf8").includes("ecr get-login-password") };
}

const image = (tag: string) => "123456789012.dkr.ecr.ap-south-1.amazonaws.com/invookemail-prod/api:" + tag;

test("an older commit never replaces a release that already contains it", () => {
  const stale = releaseCommit(olderCommit, { image: image(newerCommit), apiCount: "1" });
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, new RegExp("Production already runs " + newerCommit));
  assert.equal(stale.didPublish, false);

  const current = releaseCommit(newerCommit, { image: image(newerCommit), apiCount: "1" });
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.didPublish, false);
});

test("a newer commit, an unfinished release of the same commit, or a manual tag is released", () => {
  for (const [commit, deployed] of [
    [newerCommit, { image: image(olderCommit), apiCount: "1" }],
    // A release stopped after installing its images but before starting the services.
    [newerCommit, { image: image(newerCommit), apiCount: "0" }],
    [newerCommit, { image: image("dc3a879-20261018190000"), apiCount: "1" }],
    [newerCommit, { image: "", apiCount: "0" }],
  ] as const) {
    assert.equal(releaseCommit(commit, deployed).didPublish, true, JSON.stringify(deployed));
  }
});

test("only a full commit SHA can be released", () => {
  const result = releaseCommit(newerCommit.slice(0, 7), { image: "", apiCount: "0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /full commit SHA/);
  assert.equal(result.didPublish, false);
});
