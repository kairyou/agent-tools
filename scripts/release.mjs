#!/usr/bin/env node
// Release helper for this package.
//
// Usage:
//   npm run release [-- minor|major]   # default: patch
//   npm run release -- --dry-run       # npm test + preview tarball, no bump/push
//
// Local steps: clean-tree check -> npm test -> npm version -> git push --follow-tags.
// Publishing runs on GitHub Actions via npm trusted publishing (OIDC, no
// tokens, no npm login): .github/workflows/release.yml publishes when the
// version tag lands.
//
// Release when scripts/ integrations/ config.default.jsonc or
// package.json deps change — npx users only get these from the published package.
// (skills/ ships from GitHub via `npx skills add`; no release needed.)

import { spawnSync } from "node:child_process";

const BUMPS = ["patch", "minor", "major"];

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

function run(command) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\nAborted: \`${command}\` exited with ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

const status = spawnSync("git status --porcelain", { shell: true, encoding: "utf8" });
if (!dryRun && status.stdout.trim() !== "") {
  console.error("Working tree is not clean — commit or stash first:\n" + status.stdout);
  process.exit(1);
}

run("npm test");

if (dryRun) {
  // Shows exactly which files would ship; verify nothing is missing/extra.
  run("npm pack --dry-run");
  console.log("\nDry run complete. No version bump, nothing pushed.");
  process.exit(0);
}

run(`npm version ${bump}`);
run("git push --follow-tags");

console.log(
  "\nTag pushed. GitHub Actions publishes it: https://github.com/kairyou/agent-tools/actions"
);
