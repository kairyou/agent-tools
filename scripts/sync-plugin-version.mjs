#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const targets = [
  [".claude-plugin/plugin.json", []],
  [".codex-plugin/plugin.json", []],
  [".zcode-plugin/plugin.json", []],
];

for (const [relativePath, parentPath] of targets) {
  const file = path.join(ROOT, relativePath);
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  let target = document;
  for (const key of parentPath) target = target[key];
  target.version = version;
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

// npm version stages package.json and lockfiles itself. Include the plugin
// manifests in that same version commit before npm creates the release tag.
if (process.env.npm_lifecycle_event === "version") {
  const result = spawnSync("git", ["add", "--", ...targets.map(([file]) => file)], {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
