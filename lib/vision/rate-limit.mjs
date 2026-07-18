// Process-local rate limiting. Semantics the runtime can actually enforce:
// concurrent requests in this MCP/CLI process, plus a rolling one-minute
// window. Turn- and session-scoped limits are model behavior (Skill), not
// runtime guarantees — stdio MCP has no reliable turn or session identity.

import { ERROR_CODES, VisionError } from "./errors.mjs";

const WINDOW_MS = 60_000;

export function createLimiter({ maxConcurrentRequests, maxRequestsPerMinute }, now = Date.now) {
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
