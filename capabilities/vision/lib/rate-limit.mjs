// Process-local rate limiting. Semantics the runtime can actually enforce:
// concurrent requests in this MCP/CLI process, plus a rolling one-minute
// window. Turn- and session-scoped limits are model behavior (Skill), not
// runtime guarantees — stdio MCP has no reliable turn or session identity.

import { ERROR_CODES, VisionError } from "./errors.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const WINDOW_MS = 60_000;

function createProcessLimiter({ maxConcurrentRequests, maxRequestsPerMinute }, now) {
  let active = 0;
  const windowStarts = [];

  function acquire() {
    if (active >= maxConcurrentRequests) {
      throw new VisionError(
        ERROR_CODES.RATE_LIMIT,
        `Concurrent request limit reached (vision.maxConcurrentRequests = ${maxConcurrentRequests}). Retry after in-flight calls finish.`
      );
    }
    if (maxRequestsPerMinute > 0) {
      const cutoff = now() - WINDOW_MS;
      while (windowStarts.length > 0 && windowStarts[0] <= cutoff) windowStarts.shift();
      if (windowStarts.length >= maxRequestsPerMinute) {
        throw new VisionError(
          ERROR_CODES.RATE_LIMIT,
          `Rate limit reached (vision.maxRequestsPerMinute = ${maxRequestsPerMinute}). Retry after the window resets.`
        );
      }
      windowStarts.push(now());
    }
    active++;
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      active--;
    };
  }

  async function run(fn) {
    const release = acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { acquire, run };
}

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function withLockedState(stateFile, fn) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lockDir = `${stateFile}.lock`;
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new VisionError(ERROR_CODES.RATE_LIMIT, "Timed out acquiring the shared vision rate-limit lock.");
      }
      sleep(LOCK_WAIT_MS);
    }
  }

  try {
    let state = { windowStarts: [], active: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (Array.isArray(parsed?.windowStarts)) state.windowStarts = parsed.windowStarts;
      if (Array.isArray(parsed?.active)) state.active = parsed.active;
    } catch {
      // A missing or interrupted old state file starts a fresh bounded window.
    }
    const result = fn(state);
    const temp = `${stateFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(state)}\n`);
      fs.rmSync(stateFile, { force: true });
      fs.renameSync(temp, stateFile);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return result;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function createSharedLimiter(
  { maxConcurrentRequests, maxRequestsPerMinute, timeoutMs },
  now,
  stateFile
) {
  const leaseTtlMs = Math.max(60_000, Number(timeoutMs || 0) * 2);

  function acquire() {
    const leaseId = crypto.randomUUID();
    withLockedState(stateFile, (state) => {
      const current = now();
      const cutoff = current - WINDOW_MS;
      state.windowStarts = state.windowStarts.filter((value) => Number.isFinite(value) && value > cutoff);
      state.active = state.active.filter(
        (lease) =>
          lease &&
          typeof lease.id === "string" &&
          Number.isFinite(lease.startedAt) &&
          current - lease.startedAt <= leaseTtlMs &&
          processIsAlive(lease.pid)
      );
      if (state.active.length >= maxConcurrentRequests) {
        throw new VisionError(
          ERROR_CODES.RATE_LIMIT,
          `Concurrent request limit reached (vision.maxConcurrentRequests = ${maxConcurrentRequests}). Retry after in-flight calls finish.`
        );
      }
      if (maxRequestsPerMinute > 0 && state.windowStarts.length >= maxRequestsPerMinute) {
        throw new VisionError(
          ERROR_CODES.RATE_LIMIT,
          `Rate limit reached (vision.maxRequestsPerMinute = ${maxRequestsPerMinute}). Retry after the window resets.`
        );
      }
      if (maxRequestsPerMinute > 0) state.windowStarts.push(current);
      state.active.push({ id: leaseId, pid: process.pid, startedAt: current });
    });

    let released = false;
    return function release() {
      if (released) return;
      released = true;
      withLockedState(stateFile, (state) => {
        state.active = state.active.filter((lease) => lease?.id !== leaseId);
      });
    };
  }

  async function run(fn) {
    const release = acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { acquire, run };
}

export function createLimiter(config, now = Date.now, { stateFile = null } = {}) {
  return stateFile
    ? createSharedLimiter(config, now, stateFile)
    : createProcessLimiter(config, now);
}
