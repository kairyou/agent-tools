#!/usr/bin/env node
// Release helper for this package.
//
// Usage:
//   npm run release [-- patch|minor|major]
//     Test, bump, publish to the configured npm registry, then push the commit and v* tag.
//   npm run release:github [-- patch|minor|major]
//     Test, bump, and push the commit and v* tag; GitHub Actions publishes the package.
//   npm run release -- --publish-only [--registry=<url>] [--auth-type=legacy]
//     Publish the current version only; do not test, bump, commit, tag, or push.
//   npm run release -- --dry-run
//     Test and preview the package; do not authenticate, bump, publish, or push.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLISH_SCRIPT = path.join(ROOT, "scripts", "publish.mjs");
const BUMPS = ["patch", "minor", "major"];

let target = "registry";
let bump = "patch";
let bumpSpecified = false;
let dryRun = false;
let publishOnly = false;
const publishArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--publish-only") publishOnly = true;
  else if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
  else if (arg.startsWith("--registry=") || arg.startsWith("--auth-type=")) {
    publishArgs.push(arg);
  } else if (BUMPS.includes(arg)) {
    bump = arg;
    bumpSpecified = true;
  } else {
    console.error(
      `Unknown argument: ${arg} ` +
        `(expected ${BUMPS.join("|")}, --publish-only, --dry-run, ` +
        `--registry=<url>, or --auth-type=<type>)`
    );
    process.exit(2);
  }
}

if (!["registry", "github"].includes(target)) {
  console.error(`Unknown release target: ${target} (expected registry or github)`);
  process.exit(2);
}
if (target === "github" && publishArgs.length > 0) {
  console.error("--registry and --auth-type only apply to registry releases.");
  process.exit(2);
}
if (target === "github" && publishOnly) {
  console.error("--publish-only only applies to registry releases.");
  process.exit(2);
}
if (publishOnly && (dryRun || bumpSpecified)) {
  console.error("--publish-only cannot be combined with a version bump or --dry-run.");
  process.exit(2);
}

function run(command, args, { label, onFailure } = {}) {
  console.log(`\n> ${label || [command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) {
    console.error(`\nAborted: ${result.error.message}`);
    onFailure?.();
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nAborted: command exited with ${result.status}.`);
    onFailure?.();
    process.exit(result.status ?? 1);
  }
}

function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    run(process.execPath, [npmExecPath, ...args], { label: `npm ${args.join(" ")}` });
  } else {
    run(process.platform === "win32" ? "npm.cmd" : "npm", args);
  }
}

function printRecovery(commands) {
  console.error("\nResume without creating another version:");
  for (const command of commands) console.error(`  ${command}`);
}

const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
if (status.error || status.status !== 0) {
  console.error(status.error?.message || status.stderr || "Unable to read git status.");
  process.exit(status.status ?? 1);
}
if (!dryRun && status.stdout.trim() !== "") {
  console.error("Working tree is not clean - commit or stash first:\n" + status.stdout);
  process.exit(1);
}

if (publishOnly) {
  run(process.execPath, [PUBLISH_SCRIPT, ...publishArgs], {
    label: `node scripts/publish.mjs ${publishArgs.join(" ")}`.trimEnd(),
  });
  process.exit(0);
}

if (!dryRun && target === "registry") {
  run(process.execPath, [PUBLISH_SCRIPT, "--auth-only", ...publishArgs], {
    label: `node scripts/publish.mjs --auth-only ${publishArgs.join(" ")}`.trimEnd(),
  });
}
runNpm(["test"]);

if (dryRun) {
  runNpm(["pack", "--dry-run"]);
  console.log("\nDry run complete. No authentication, version bump, publish, or push.");
  process.exit(0);
}

const versionArgs = ["version", bump, "--tag-version-prefix=v"];
if (target === "registry") versionArgs.push("--message=%s [skip ci]");
runNpm(versionArgs);
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const tag = `v${version}`;

if (target === "registry") {
  run(process.execPath, [PUBLISH_SCRIPT, ...publishArgs], {
    label: `node scripts/publish.mjs ${publishArgs.join(" ")}`.trimEnd(),
    onFailure() {
      const suffix = publishArgs.length > 0 ? ` ${publishArgs.join(" ")}` : "";
      printRecovery([
        `npm run release -- --publish-only${suffix}`,
        "git push --follow-tags",
      ]);
    },
  });
  run("git", ["push", "--follow-tags"], {
    onFailure() {
      printRecovery(["git push --follow-tags"]);
    },
  });
  console.log(`\nReleased ${tag} to the configured npm registry.`);
} else {
  run("git", ["push", "--follow-tags"], {
    onFailure() {
      printRecovery(["git push --follow-tags"]);
    },
  });
  console.log(`\nPushed ${tag}. GitHub Actions will publish it.`);
}
