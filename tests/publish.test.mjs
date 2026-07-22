import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISH_SCRIPT = fileURLToPath(new URL("../scripts/publish.mjs", import.meta.url));

function runPublish({ authenticated, args = ["--auth-type=legacy"] }) {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-publish-"));
  const fakeNpm = join(temp, "fake-npm.mjs");
  const calls = join(temp, "calls.jsonl");
  writeFileSync(
    fakeNpm,
    `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "config" && args[2] === "@kairyou:registry") {
  console.log("https://nexus.example.test/repository/npm-hosted/");
} else if (
  args[0] === "whoami" &&
  process.env.FAKE_NPM_AUTHENTICATED !== "true" &&
  !existsSync(process.env.FAKE_NPM_AUTH_FILE)
) {
  process.exit(1);
} else if (args[0] === "login") {
  writeFileSync(process.env.FAKE_NPM_AUTH_FILE, "authenticated");
}
`
  );
  const result = spawnSync(process.execPath, [PUBLISH_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_TOOLS_HOME: join(temp, "agent-tools-home"),
      npm_execpath: fakeNpm,
      FAKE_NPM_CALLS: calls,
      FAKE_NPM_AUTH_FILE: join(temp, "authenticated"),
      FAKE_NPM_AUTHENTICATED: String(authenticated),
    },
  });
  return {
    result,
    calls: existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
      : [],
    publishNpmrc: join(temp, "agent-tools-home", "publish.npmrc"),
  };
}

test("local publisher resolves a scoped registry and reuses saved authentication", () => {
  const { result, calls, publishNpmrc } = runPublish({ authenticated: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(([command]) => command), ["config", "whoami", "publish"]);
  assert.ok(calls[2].includes(`--userconfig=${publishNpmrc}`));
  assert.ok(calls[2].includes("--registry=https://nexus.example.test/repository/npm-hosted/"));
});

test("local publisher logs in to its persistent npmrc when authentication is missing", () => {
  const { result, calls, publishNpmrc } = runPublish({ authenticated: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(([command]) => command), [
    "config",
    "whoami",
    "login",
    "whoami",
    "publish",
  ]);
  assert.ok(calls[2].includes(`--userconfig=${publishNpmrc}`));
  assert.ok(calls[2].includes("--auth-type=legacy"));
});

test("authentication preflight does not publish", () => {
  const { result, calls } = runPublish({ authenticated: true, args: ["--auth-only"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(([command]) => command), ["config", "whoami"]);
  assert.match(result.stdout, /Authenticated for https:\/\/nexus\.example\.test/);
});
