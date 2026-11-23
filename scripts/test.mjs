import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const parent = resolve(tmpdir());
const prefix = "agent-tools-tests-";
const scratch = resolve(mkdtempSync(join(parent, prefix)));
if (dirname(scratch) !== parent || !basename(scratch).startsWith(prefix)) {
  throw new Error(`Unexpected test directory: ${scratch}`);
}

try {
  const args = process.argv.slice(2);
  const result = spawnSync(process.execPath, [
    "--test", "--test-concurrency=1", ...(args.length ? args : ["tests/*.test.mjs"]),
  ], {
    env: { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}
