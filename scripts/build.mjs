#!/usr/bin/env node
// Bundles everything that ships to ~/.agent-tools into dist/<capability>.
// Installed artifacts are always built output; integrations/ holds the sources.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const TARGETS = {
  statusline: {
    entryPoints: {
      "claude-statusline": path.join(ROOT, "integrations", "statusline", "claude-statusline.mjs"),
    },
  },
  usage: {
    entryPoints: {
      core: path.join(ROOT, "integrations", "usage", "core.mjs"),
      cli: path.join(ROOT, "integrations", "usage", "cli.mjs"),
      "codex-hook": path.join(ROOT, "integrations", "usage", "codex-hook.mjs"),
      "opencode-plugin": path.join(ROOT, "integrations", "usage", "opencode-plugin.mjs"),
      "opencode-tui": path.join(ROOT, "integrations", "usage", "opencode-tui.mjs"),
    },
    // core.mjs detects "run as a script" via process.argv[1]; inlining it into
    // the other entries would re-trigger that check inside their bundles, so it
    // stays a sibling file that they import at runtime.
    external: ["./core.mjs"],
  },
  vision: {
    entryPoints: {
      "mcp-server": path.join(ROOT, "integrations", "vision", "mcp-server.mjs"),
      cli: path.join(ROOT, "integrations", "vision", "lib", "cli.mjs"),
    },
  },
  log: {
    entryPoints: {
      hook: path.join(ROOT, "integrations", "log", "hook.mjs"),
      "opencode-plugin": path.join(ROOT, "integrations", "log", "opencode-plugin.mjs"),
    },
  },
};

// Repo-shipped usage routes (a fork can commit integrations/usage/routes/*.mjs
// to distribute custom gateways to everyone who installs). Absent upstream.
const USAGE_ROUTES_DIR = path.join(ROOT, "integrations", "usage", "routes");
if (fs.existsSync(USAGE_ROUTES_DIR)) {
  for (const file of fs.readdirSync(USAGE_ROUTES_DIR).filter((n) => n.endsWith(".mjs"))) {
    TARGETS.usage.entryPoints[`routes/${file.slice(0, -4)}`] = path.join(USAGE_ROUTES_DIR, file);
  }
}

for (const [name, { entryPoints, external = [] }] of Object.entries(TARGETS)) {
  const outDir = path.join(DIST, name);
  const stage = path.join(DIST, `.${name}-build-${process.pid}-${Date.now()}`);
  try {
    await build({
      entryPoints,
      outdir: stage,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      mainFields: ["module", "main"],
      outExtension: { ".js": ".mjs" },
      packages: "bundle",
      external,
      sourcemap: false,
      legalComments: "none",
    });

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(stage, outDir);
    console.log(`built ${path.relative(ROOT, outDir)}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
