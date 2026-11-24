import { App } from "@modelcontextprotocol/ext-apps";

// The panel has no turn-completion event. Check at the same cadence as gateway refreshes.
const PANEL_REFRESH_MS = 60_000;
const app = new App({ name: "Agent Tools usage", version: "1.0.0" });
const usage = document.getElementById("usage");
const speed = document.getElementById("speed");
const refreshButton = document.getElementById("refresh");
let refreshed = false;
let timer;
let pending = false;
let closed = false;

function render({ structuredContent, isError } = {}) {
  if (isError) return;
  const { quota, speed: rate } = structuredContent ?? {};
  usage.textContent = quota || (rate ? "" : "No usage available yet.");
  usage.hidden = !usage.textContent;
  speed.textContent = rate || "";
  speed.hidden = !rate;
}

app.ontoolresult = (result) => {
  if (!closed && !refreshed) render(result);
};

async function refresh(force) {
  if (closed || pending || (!force && document.hidden)) return;
  clearTimeout(timer);
  pending = true;
  refreshButton.disabled = true;
  try {
    const result = await app.callServerTool({ name: "usage_panel", arguments: { refresh: force } });
    if (closed || result.isError) return;
    refreshed = true;
    render(result);
  } catch {
    // Keep the last result available during a host connection failure.
  } finally {
    pending = false;
    if (!closed) {
      refreshButton.disabled = false;
      if (!document.hidden) timer = setTimeout(() => void refresh(false), PANEL_REFRESH_MS);
    }
  }
}

function onVisibilityChange() {
  clearTimeout(timer);
  if (!document.hidden) void refresh(false);
}

refreshButton.onclick = () => refresh(true);
app.onteardown = () => {
  closed = true;
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  return {};
};

try {
  await app.connect();
  if (!closed) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    refreshButton.disabled = false;
    void refresh(false);
  }
} catch { render(); }
