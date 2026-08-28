#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
