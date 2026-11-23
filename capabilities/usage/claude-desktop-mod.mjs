import { formatOutputSpeed } from "./lib/output-speed-format.mjs";
import { usageSummary } from "./lib/usage-summary.mjs";

const runtime = "__AGENT_TOOLS_DESKTOP_RUNTIME__";
const PANE = "agent-tools-gateway-usage";
// Match the shared gateway cache refresh interval while the session is open.
const REFRESH_MS = 60_000;
// Let the host answer during turn completion without holding up a finished turn.
const SESSION_ID_TIMEOUT_MS = 250;

async function refreshOutputSpeed($, state) {
  try {
    const result = await $.process.run([...runtime.command, "--settings"], { env: { AGENT_TOOLS_HOME: runtime.home } });
    if (state.ended || result.exitCode !== 0) return;
    const { outputSpeed, routed } = JSON.parse(result.stdout);
    state.routed = routed === true;
    const enabled = outputSpeed === true;
    if (state.outputSpeed === enabled) return;
    state.outputSpeed = enabled;
    $.ui.invalidate("ui.render");
  } catch { /* Keep the last known setting if the worker fails. */ }
}

async function refreshGateway($, state) {
  const sessionId = state.sessionId;
  if (state.ended || (state.quotaRequest && state.quotaRequest.sessionId === sessionId)) return;
  const request = { sessionId };
  state.quotaRequest = request;
  let gateway = "";
  try {
    const command = sessionId ? [...runtime.command, "--session-id", sessionId] : runtime.command;
    const result = await $.process.run(command, { env: { AGENT_TOOLS_HOME: runtime.home } });
    if (result.exitCode === 0) {
      const data = JSON.parse(result.stdout);
      if (typeof data.gateway === "string") gateway = data.gateway;
    }
  } catch {
    // Unavailable usage should leave the band empty.
  }
  if (state.quotaRequest !== request) return;
  state.quotaRequest = undefined;
  if (state.ended || state.gateway === gateway) return;
  state.gateway = gateway;
  $.ui.invalidate("ui.render");
}

async function refresh($, state) {
  await Promise.all([refreshOutputSpeed($, state), refreshGateway($, state)]);
}

export function register(on) {
  let session = {};

  on("session.end", ($, event, next) => {
    session.ended = true;
    session.timer?.cancel();
    session = {};
    return next(event);
  });

  on("turn.step", async function* ($, event, next) {
    const state = session;
    if (!state.timer || event.agentId) return yield* next(event);
    const request = Symbol();
    state.request = request;
    const start = await $.clock.now().catch(() => NaN);
    const result = yield* next(event);
    const end = await $.clock.now().catch(() => NaN);
    if (session === state && state.request === request) {
      const tokens = result?.usage?.output_tokens;
      state.speed = tokens > 0 && result.stopReason ? formatOutputSpeed(tokens, end - start) : "";
      if (state.outputSpeed) $.ui.invalidate("ui.render");
    }
    return result;
  });

  on("turn.complete", async ($, event, next) => {
    const state = session;
    const result = await next(event);
    if (state.ended || !state.timer || state.routed === false || event.agentId || event.isAborted) return result;
    let sessionId;
    try {
      const id = await Promise.race([$.session.id(), $.clock.sleep(SESSION_ID_TIMEOUT_MS)]);
      if (typeof id === "string" && id.trim()) sessionId = id;
    } catch { /* The usage worker can look up its parent process. */ }
    if (state.ended) return result;
    state.sessionId = sessionId;
    void refreshGateway($, state);
    return result;
  });

  on("ui.render", { component: "AbovePrompt", surface: "desktop" }, async ($, event, next) => {
    const state = session;
    if (!state.timer) {
      state.timer = $.clock.every(REFRESH_MS, () => refresh($, state));
      void refresh($, state);
    }
    const summary = state.gateway ? usageSummary(state.gateway) : "";
    const label = [summary, state.outputSpeed && state.speed].filter(Boolean).join(" | ");
    if (!label) return next(event);

    const { Box, Text, Button } = $.ui.resolve(event);
    const row = summary ? Button({
      key: "gateway-usage", label, plain: true,
      onPress: async () => {
        try { await $.ui.open({ id: PANE, title: "Gateway usage", focus: true, closeOnEscape: true }); }
        catch { /* The details may already be open. */ }
      },
    }) : Text({ children: [label], dimColor: true });
    const following = await next(event);
    return following ? Box({ flexDirection: "column", children: [row, following] }) : row;
  });

  on("ui.render", { component: "Pane", surface: "desktop" }, ($, event, next) => {
    if (event.requestId !== PANE) return next(event);
    const { Text } = $.ui.resolve(event);
    return Text({ children: [session.gateway || "Gateway usage is unavailable."] });
  });
}
