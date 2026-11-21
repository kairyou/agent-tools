import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";

const runGit = promisify(execFile);
// Keep branch lookup within Codex's one-second resource read deadline.
const GIT_BRANCH_TIMEOUT_MS = 350;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

async function gitBranch(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return "";
  try {
    const { stdout } = await runGit("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd, encoding: "utf8", windowsHide: true, timeout: GIT_BRANCH_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function limitText(windows, position, minutes, label) {
  const fallback = windows[position];
  const window = windows.find((item) => item?.window_minutes === minutes) ??
    (fallback?.window_minutes == null ? fallback : undefined);
  if (!Number.isFinite(window?.used_percent)) return "";
  return `${label} ${Math.round(Math.min(100, Math.max(0, 100 - window.used_percent)))}% left`;
}

function compactAmount(value, label) {
  return Number.isFinite(value) && value >= 0 ? `${compact.format(value)} ${label}` : "";
}

function usedTokens(total) {
  if (!total) return "";
  // Match Codex's blended total, which excludes cache reads from the count.
  const used = total.total_input_tokens - total.cache_read_input_tokens + total.output_tokens;
  return used > 0 ? compactAmount(used, "used") : "";
}

function estimatedCost(cost) {
  if (!Number.isFinite(cost) || cost < 0) return "";
  const decimals = cost > 0 && cost < 0.0001 ? 6 : cost > 0 && cost < 0.01 ? 4 : 2;
  return `~$${cost.toFixed(decimals)}`;
}

function approvalMode(approval) {
  if (approval?.policy === "on-request") {
    return approval.reviewer === "auto-review" ? "Approve for me" : "Ask for approval";
  }
  return approval?.policy;
}

const fields = {
  model: ({ model }) => model?.display_name,
  "model-with-reasoning": ({ model }) => [model?.display_name, model?.reasoning_level].filter(Boolean).join(" "),
  reasoning: ({ model }) => model?.reasoning_level,
  provider: ({ model }) => model?.provider,
  profile: ({ config }) => config?.profile,
  "current-dir": ({ cwd }) => cwd,
  "project-name": ({ cwd }) => cwd && basename(cwd),
  "git-branch": ({ cwd }) => gitBranch(cwd),
  "context-remaining": ({ used }) => Number.isFinite(used) && `Context ${Math.max(0, 100 - used)}% left`,
  "context-used": ({ used }) => Number.isFinite(used) && `Context ${used}% used`,
  "context-window-size": ({ usage }) => compactAmount(usage?.context?.context_window_size, "window"),
  "used-tokens": ({ usage }) => usedTokens(usage?.total),
  "total-input-tokens": ({ usage }) => compactAmount(usage?.total?.total_input_tokens, "in"),
  "total-output-tokens": ({ usage }) => compactAmount(usage?.total?.output_tokens, "out"),
  "thread-credits": ({ usage }) => compactAmount(usage?.cost?.total_credits, "credits"),
  "estimated-thread-cost": ({ usage }) => estimatedCost(usage?.cost?.total_cost_usd),
  "five-hour-limit": ({ windows }) => limitText(windows, 0, 5 * 60, "5h"),
  "weekly-limit": ({ windows }) => limitText(windows, 1, 7 * 24 * 60, "weekly"),
  "thread-name": ({ thread }) => thread.name,
  "thread-title": ({ thread }) => thread.name || thread.id,
  "thread-id": ({ thread }) => thread.id,
  "codex-version": ({ app }) => app?.cli_version && `v${app.cli_version}`,
  "run-state": ({ thread }) => thread.agent?.state?.replace(/^./, (letter) => letter.toUpperCase()),
  permissions: ({ thread }) => thread.permissions?.display_name,
  "approval-mode": ({ thread }) => approvalMode(thread.approval),
  "fast-mode": ({ model }) => model?.service_tier_display_name || "Standard",
  "raw-output": ({ app }) => app?.display_mode === "raw" && "raw output",
  "workspace-headline": ({ account }) => account?.workspace?.headline,
};

export function supportsCodexStatuslineField(name) {
  return typeof name === "string" && Object.hasOwn(fields, name);
}

export async function nativeFields(state) {
  const { account, app, config, thread } = state;
  const { model, workspace, usage } = thread;
  const limits = account?.rate_limits?.find((item) => item.limit_id === "codex");
  const selected = config?.statusline_items ?? ["model-with-reasoning", "context-remaining"];
  const view = {
    account, app, config, thread, model, usage,
    cwd: workspace?.cwd,
    used: usage?.context?.used_percentage,
    windows: [limits?.primary_limit, limits?.secondary_limit],
  };
  const rendered = await Promise.all(selected.filter(supportsCodexStatuslineField).map((item) => fields[item](view)));
  return rendered.filter(Boolean);
}
