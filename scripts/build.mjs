#!/usr/bin/env node
// Bundles everything that ships to ~/.agent-tools into dist/<capability>.
// Installed artifacts are always built output; capabilities/ holds the sources.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

async function buildZcodeMarketplace(stage, options) {
  const dir = path.join(stage, "zcode-marketplace");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities", "usage", "zcode-extension.json"), "utf8"));
  const pluginDir = path.join(dir, manifest.name);
  // ZCode copies a plugin into its cache, so bundle the runtime into its entry.
  await build({ ...options, entryPoints: [path.join(ROOT, "capabilities", "usage", "zcode-extension.mjs")],
    outfile: path.join(pluginDir, "zcode-extension.mjs") });
  const manifestDir = path.join(pluginDir, ".zcode-plugin");
  fs.mkdirSync(manifestDir, { recursive: true });
  const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  writeJson(path.join(manifestDir, "plugin.json"), { ...manifest, version: PACKAGE_VERSION });
  writeJson(path.join(dir, "marketplace.json"), {
    name: "agent-tools-local",
    owner: manifest.author,
    plugins: [{ name: manifest.name, source: `./${manifest.name}`, description: manifest.description, version: PACKAGE_VERSION }],
  });
}

async function buildPaseoPlugin(stage, options) {
  const src = path.join(ROOT, "capabilities", "usage");
  const dir = path.join(stage, "paseo");
  const external = ["@getpaseo/plugin", "zod"];
  await build({ ...options, external, entryPoints: [path.join(src, "paseo-server.mjs")],
    outfile: path.join(dir, "index.server.ts") });
  await build({ ...options, platform: "browser", target: "es2022", external: [...external, "react", "react-native"],
    entryPoints: [path.join(src, "paseo-client.mjs")], outfile: path.join(dir, "index.client.tsx") });
  fs.copyFileSync(path.join(src, "paseo-plugin.json"), path.join(dir, "paseo-plugin.json"));
}

const TARGETS = {
  statusline: {
    entryPoints: {
      "claude-statusline": path.join(ROOT, "capabilities", "statusline", "claude-statusline.mjs"),
    },
  },
  usage: {
    entryPoints: {
      core: path.join(ROOT, "capabilities", "usage", "core.mjs"),
      cli: path.join(ROOT, "capabilities", "usage", "cli.mjs"),
      "codex-hook": path.join(ROOT, "capabilities", "usage", "codex-hook.mjs"),
      "opencode-plugin": path.join(ROOT, "capabilities", "usage", "opencode-plugin.mjs"),
      "opencode-tui": path.join(ROOT, "capabilities", "usage", "opencode-tui.mjs"),
      "pi-extension": path.join(ROOT, "capabilities", "usage", "pi-extension.mjs"),
      "dsh-plugin": path.join(ROOT, "capabilities", "usage", "dsh-plugin.mjs"),
      "dsh-client": path.join(ROOT, "capabilities", "usage", "dsh-client.mjs"),
    },
    // core.mjs detects "run as a script" via process.argv[1]; inlining it into
    // the other entries would re-trigger that check inside their bundles, so it
    // stays a sibling file that they import at runtime.
    external: ["./core.mjs"],
  },
  vision: {
    entryPoints: {
      "mcp-server": path.join(ROOT, "capabilities", "vision", "mcp-server.mjs"),
      cli: path.join(ROOT, "capabilities", "vision", "lib", "cli.mjs"),
      "pi-extension": path.join(ROOT, "capabilities", "vision", "pi-extension.mjs"),
    },
  },
  log: {
    entryPoints: {
      hook: path.join(ROOT, "capabilities", "log", "hook.mjs"),
      "opencode-plugin": path.join(ROOT, "capabilities", "log", "opencode-plugin.mjs"),
      "pi-extension": path.join(ROOT, "capabilities", "log", "pi-extension.mjs"),
      "zcode-hook": path.join(ROOT, "capabilities", "log", "zcode-hook.mjs"),
      "dsh-plugin": path.join(ROOT, "capabilities", "log", "dsh-plugin.mjs"),
    },
  },
};

// Repo-shipped usage routes (a fork can commit capabilities/usage/routes/*.mjs
// to distribute custom gateways to everyone who installs). Absent upstream.
const USAGE_ROUTES_DIR = path.join(ROOT, "capabilities", "usage", "routes");
if (fs.existsSync(USAGE_ROUTES_DIR)) {
  for (const file of fs.readdirSync(USAGE_ROUTES_DIR).filter((n) => n.endsWith(".mjs"))) {
    TARGETS.usage.entryPoints[`routes/${file.slice(0, -4)}`] = path.join(USAGE_ROUTES_DIR, file);
  }
}

for (const [name, { entryPoints, external = [] }] of Object.entries(TARGETS)) {
  const outDir = path.join(DIST, name);
  const stage = path.join(DIST, `.${name}-build-${process.pid}-${Date.now()}`);
  try {
    const options = {
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      mainFields: ["module", "main"],
      outExtension: { ".js": ".mjs" },
      packages: "bundle",
      sourcemap: false,
      legalComments: "none",
    };
    await build({ ...options, entryPoints, outdir: stage, external });

    if (name === "usage") {
      fs.copyFileSync(path.join(ROOT, "capabilities", "usage", "dsh-package.json"), path.join(stage, "package.json"));
      await buildZcodeMarketplace(stage, options);
      await buildPaseoPlugin(stage, options);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(stage, outDir);
    console.log(`built ${path.relative(ROOT, outDir)}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
