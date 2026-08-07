#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CURRENT_FILE,
  MirrorPendingError,
  PENDING_FILE,
  REPORT_FILE,
  ROOT,
  compareSnapshots,
  discoverLatestVersion,
  discoverLatestMirrorVersion,
  fetchUpstream,
  readJson,
  renderReport,
  stableJson,
  writePending,
} from "./lib.mjs";
import { SKILLS } from "./manifest.mjs";
import { LOCAL_LOCKED_HASHES, renderSkills } from "./render.mjs";

function usage() {
  console.error("usage: cli.mjs <fetch|inspect|apply|check> [--version X] [--write] [--dry-run]");
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = { command: argv[0], write: false, dryRun: false, version: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--write") options.write = true;
    else if (argv[i] === "--dry-run") options.dryRun = true;
    else if (argv[i] === "--version" && argv[i + 1]) options.version = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

function unifiedDiff(file, generated) {
  const tempDir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || ROOT, "claude-skill-sync-"));
  const tempFile = path.join(tempDir, path.basename(file));
  try {
    fs.writeFileSync(tempFile, generated);
    const result = spawnSync("git", ["diff", "--no-index", "--", file, tempFile], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return result.stdout.replaceAll(tempFile.replaceAll("\\", "/"), file.replaceAll("\\", "/"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function snapshotForApply() {
  if (!fs.existsSync(PENDING_FILE)) {
    throw new Error("No pending upstream update. Run claude-skills:fetch after the mirror catches up.");
  }
  return readJson(PENDING_FILE);
}

function printNoPending() {
  if (fs.existsSync(CURRENT_FILE)) {
    const current = readJson(CURRENT_FILE);
    console.log(`No pending upstream update. Accepted Claude Code version: ${current.claudeCodeVersion}.`);
  } else {
    console.log("No pending upstream update and no accepted snapshot.");
  }
}

function showGeneratedDiff(snapshot) {
  const generated = renderSkills(snapshot);
  let changed = false;
  for (const [name, content] of Object.entries(generated)) {
    const target = path.join(ROOT, SKILLS[name].target);
    const diff = unifiedDiff(target, content);
    console.log(`\n=== ${name} ===`);
    if (diff) {
      changed = true;
      console.log(diff.trimEnd());
    } else {
      console.log("No generated change.");
    }
  }
  console.log("\nLocal-locked fragments:");
  for (const [name, hash] of Object.entries(LOCAL_LOCKED_HASHES)) console.log(`  ${name}: ${hash}`);
  return { generated, changed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command) return usage();
  if (options.command === "fetch") {
    const npmVersion = options.version || (await discoverLatestVersion());
    let version = npmVersion;
    let sourceCommit;
    if (!options.version) {
      const mirror = await discoverLatestMirrorVersion(npmVersion);
      if (!mirror) throw new Error(`Piebald has no prompt version at or below Claude Code ${npmVersion}`);
      version = mirror.version;
      sourceCommit = mirror.commit;
      if (version !== npmVersion) {
        console.log(`npm latest is Claude Code ${npmVersion}; Piebald mirror currently reaches ${version}.`);
        console.log(`Using the newest available mirrored version, ${version}.`);
      }
    }
    let snapshot;
    try {
      snapshot = await fetchUpstream(version, { commit: sourceCommit });
    } catch (error) {
      if (!(error instanceof MirrorPendingError)) throw error;
      console.log(`Piebald mirror pending for Claude Code ${error.version}.`);
      printNoPending();
      console.log("No files were written. Retry after Piebald publishes the matching prompt JSON.");
      return;
    }
    const { changes, wrote } = writePending(snapshot);
    console.log(`Fetched Claude Code ${version} from ${snapshot.source.repository}@${snapshot.source.commit}`);
    console.log(`${changes.length} selected or monitored prompt(s) differ from current.`);
    console.log(wrote ? path.relative(ROOT, REPORT_FILE) : "No pending update was written.");
    return;
  }
  if (options.command === "inspect") {
    if (!fs.existsSync(PENDING_FILE)) {
      printNoPending();
      return;
    }
    const pending = readJson(PENDING_FILE);
    const current = fs.existsSync(CURRENT_FILE) ? readJson(CURRENT_FILE) : null;
    console.log(
      fs.existsSync(REPORT_FILE) ? fs.readFileSync(REPORT_FILE, "utf8") : renderReport(current, pending)
    );
    showGeneratedDiff(pending);
    return;
  }
  if (options.command === "apply") {
    const snapshot = snapshotForApply();
    const { generated } = showGeneratedDiff(snapshot);
    if (!options.write) {
      console.log("\nDry run only. Re-run with --write after reviewing the diff.");
      return;
    }
    for (const [name, content] of Object.entries(generated)) {
      fs.writeFileSync(path.join(ROOT, SKILLS[name].target), content);
    }
    fs.writeFileSync(CURRENT_FILE, stableJson(snapshot));
    fs.rmSync(PENDING_FILE, { force: true });
    fs.rmSync(REPORT_FILE, { force: true });
    console.log(`\nApplied Claude Code ${snapshot.claudeCodeVersion} and promoted it to current.`);
    return;
  }
  if (options.command === "check") {
    if (!fs.existsSync(CURRENT_FILE)) throw new Error("No accepted upstream snapshot");
    const snapshot = readJson(CURRENT_FILE);
    const generated = renderSkills(snapshot);
    const drift = Object.entries(generated).filter(([name, content]) => {
      return fs.readFileSync(path.join(ROOT, SKILLS[name].target), "utf8") !== content;
    });
    if (drift.length) throw new Error(`Generated skills have drifted: ${drift.map(([name]) => name).join(", ")}`);
    console.log(`Claude skill sync is reproducible at ${snapshot.claudeCodeVersion}.`);
    return;
  }
  usage();
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
