#!/usr/bin/env node
// Internal registry publisher used by release.mjs.
// Publishes to npmjs or an npm-compatible private registry without changing the version.
// Credentials persist in ~/.agent-tools/publish.npmrc, leaving ~/.npmrc untouched.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PACKAGE_NAME = packageJson.name;
const PUBLISH_NPMRC = path.join(
  process.env.AGENT_TOOLS_HOME || path.join(os.homedir(), ".agent-tools"),
  "publish.npmrc"
);

let registryOverride;
let authType;
let dryRun = false;
let authOnly = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--auth-only") authOnly = true;
  else if (arg.startsWith("--registry=")) registryOverride = arg.slice("--registry=".length);
  else if (arg.startsWith("--auth-type=")) authType = arg.slice("--auth-type=".length);
  else {
    console.error(
      `Unknown argument: ${arg} ` +
        `(expected --registry=<url>, --auth-type=<type>, --auth-only, or --dry-run)`
    );
    process.exit(2);
  }
}

if (typeof PACKAGE_NAME !== "string" || PACKAGE_NAME.trim() === "") {
  console.error("package.json must define a non-empty name before publishing.");
  process.exit(2);
}

function runNpm(args, { capture = false, allowFailure = false } = {}) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function readNpmConfig(key) {
  const result = runNpm(["config", "get", key], { capture: true });
  const value = result.stdout.trim();
  return value && value !== "undefined" && value !== "null" ? value : undefined;
}

const packageScope = PACKAGE_NAME.match(/^(@[^/]+)\//)?.[1];
const registry =
  registryOverride ||
  packageJson.publishConfig?.registry ||
  (packageScope && readNpmConfig(`${packageScope}:registry`)) ||
  readNpmConfig("registry");

try {
  const url = new URL(registry);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
} catch {
  console.error("The resolved npm registry must be a valid HTTP(S) URL.");
  process.exit(2);
}

console.log(`Package:  ${PACKAGE_NAME}@${packageJson.version}`);
console.log(`Registry: ${registry}`);
if (new URL(registry).hostname === "registry.npmjs.org") {
  console.log("Note: npmjs releases normally go through `npm run release:github` (OIDC).");
}

if (dryRun) {
  runNpm(["pack", "--dry-run"]);
  process.exit(0);
}

fs.mkdirSync(path.dirname(PUBLISH_NPMRC), { recursive: true, mode: 0o700 });
if (!fs.existsSync(PUBLISH_NPMRC)) fs.writeFileSync(PUBLISH_NPMRC, "", { mode: 0o600 });

const npmConfigArgs = [`--registry=${registry}`, `--userconfig=${PUBLISH_NPMRC}`];
const whoami = runNpm(["whoami", ...npmConfigArgs], { capture: true, allowFailure: true });
if (whoami.status !== 0) {
  console.log(`Authentication required. Credentials will be saved to ${PUBLISH_NPMRC}`);
  const loginArgs = ["login", ...npmConfigArgs];
  if (authType) loginArgs.push(`--auth-type=${authType}`);
  runNpm(loginArgs);
  runNpm(["whoami", ...npmConfigArgs]);
}

if (authOnly) {
  console.log(`Authenticated for ${registry}`);
  process.exit(0);
}

runNpm(["publish", ...npmConfigArgs]);
console.log(`\nPublished ${PACKAGE_NAME}@${packageJson.version} to ${registry}`);
