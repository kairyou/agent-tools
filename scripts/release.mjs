#!/usr/bin/env node
// Release helper for this package.
//
// Usage:
//   npm run release [-- minor|major]   # default: patch
//   npm run release -- --dry-run       # npm test + preview tarball, no bump/publish
//
// Steps: clean-tree check -> npm auth check -> npm test -> npm version -> npm publish -> git push
//
// Release when scripts/ lib/ plugins/ hooks/ statusline/ config.default.jsonc or
// package.json deps change — npx users only get these from the published package.
// (skills/ ships from GitHub via `npx skills add`; no release needed.)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BUMPS = ["patch", "minor", "major"];
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const PACKAGE_NAME = packageJson.name;

if (typeof PACKAGE_NAME !== "string" || PACKAGE_NAME.trim() === "") {
  console.error("package.json must define a non-empty name before releasing.");
  process.exit(2);
}

function readNpmConfig(key) {
  const npmExecPath = process.env.npm_execpath;
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, "config", "get", key], { encoding: "utf8" })
    : spawnSync("npm", ["config", "get", key], { encoding: "utf8", shell: true });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || "npm config exited unexpectedly";
    console.error(`Unable to read npm config ${key}:\n${detail}`);
    process.exit(result.status ?? 2);
  }

  const value = result.stdout?.trim();
  return value && value !== "undefined" && value !== "null" ? value : undefined;
}

const packageScope = PACKAGE_NAME.match(/^(@[^/]+)\//)?.[1];
const REGISTRY = (packageScope && readNpmConfig(`${packageScope}:registry`)) || readNpmConfig("registry");

try {
  const registryUrl = new URL(REGISTRY);
  if (!["http:", "https:"].includes(registryUrl.protocol)) throw new Error("unsupported protocol");
} catch {
  console.error("npm registry config must be a valid HTTP(S) URL before releasing.");
  process.exit(2);
}

let bump = "patch";
let dryRun = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") dryRun = true;
  else if (BUMPS.includes(arg)) bump = arg;
  else {
    console.error(`Unknown argument: ${arg} (expected ${BUMPS.join("|")} or --dry-run)`);
    process.exit(2);
  }
}

function run(command, opts = {}) {
  const { onFailure, ...spawnOptions } = opts;
  console.log(`\n> ${command}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true, ...spawnOptions });
  if (result.status !== 0) {
    console.error(`\nAborted: \`${command}\` exited with ${result.status}.`);
    onFailure?.();
    process.exit(result.status ?? 1);
  }
}

function printCommands(message, commands) {
  console.error(`\n${message}\n`);
  for (const command of commands) console.error(`  ${command}`);
}

const status = spawnSync("git status --porcelain", { shell: true, encoding: "utf8" });
if (!dryRun && status.stdout.trim() !== "") {
  console.error("Working tree is not clean — commit or stash first:\n" + status.stdout);
  process.exit(1);
}

if (!dryRun) {
  // Fail before npm version creates a commit and tag when the saved token is stale.
  run(`npm whoami --registry=${REGISTRY}`, {
    onFailure() {
      printCommands("npm authentication is missing or expired. Log in, verify the account, then retry:", [
        `npm login --registry=${REGISTRY}`,
        `npm whoami --registry=${REGISTRY}`,
        `npm run release -- ${bump}`,
      ]);
    },
  });
}

run("npm test");

if (dryRun) {
  // Shows exactly which files would ship; verify nothing is missing/extra.
  run("npm pack --dry-run");
  console.log("\nDry run complete. No version bump, nothing published.");
  process.exit(0);
}

run(`npm version ${bump}`);
run("npm publish", {
  onFailure() {
    printCommands(
      "npm publish failed after the version commit and tag were created. Do not run the release command again. Fix authentication/permissions, then resume:",
      [
        `npm login --registry=${REGISTRY}`,
        `npm whoami --registry=${REGISTRY}`,
        `npm owner ls ${PACKAGE_NAME}`,
        "npm publish",
        `npm view ${PACKAGE_NAME} version`,
        "git push --follow-tags",
      ],
    );
  },
});
run("git push --follow-tags");

console.log("\nRelease complete.");
