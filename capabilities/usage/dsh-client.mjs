import { usageSummary } from "./lib/usage-summary.mjs";

const styles = `
  .agent-tools-usage { position: relative; display: inline-flex; min-width: 0;
    font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
    line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
  .agent-tools-usage-summary { box-sizing: border-box; font: inherit; font-variant-numeric: tabular-nums;
    color: var(--dsw-alias-label-tertiary, inherit); border: 0; background: none;
    min-width: 0; max-width: 11rem; padding: 1px 8px;
    border-radius: var(--dsw-radius-sm, 6px); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  button.agent-tools-usage-summary { cursor: pointer; }
  button.agent-tools-usage-summary:hover, button.agent-tools-usage-summary[aria-expanded=true] {
    color: var(--dsw-alias-label-secondary, inherit);
    background: var(--dsw-alias-interactive-bg-hover, transparent); }
  .agent-tools-usage-detail { position: absolute; bottom: calc(100% + 4px); inset-inline-end: 0;
    max-width: min(26rem, 80vw); width: max-content; overflow-wrap: anywhere;
    padding: 0.45rem 0.65rem; border: 1px solid var(--dsw-alias-border-l1, currentColor);
    border-radius: var(--dsw-radius-sm, 6px);
    background: var(--dsw-specific-menu, Canvas); color: var(--dsw-alias-label-secondary, CanvasText);
    backdrop-filter: var(--dsw-menu-backdrop-filter, none);
    box-shadow: var(--dsw-elevation-prominent, none); z-index: 2; }
`;

window.__ModuleLoader__.load({
  id: "@kairyou/agent-tools-dsh-usage",
  factory(require) {
    const { createElement: h, useEffect, useState } = require("react");

    function Usage({ sessionId, usage }) {
      const [text, setText] = useState("");
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        async function refresh() {
          try {
            const response = await fetch(`api/agent-tools.usage?${new URLSearchParams({ sessionId })}`, { signal });
            if (!response.ok) return;
            const data = await response.json();
            if (!signal.aborted) setText(typeof data?.text === "string" ? data.text : "");
          } catch { /* Retain the last reading until the next session update. */ }
        }
        void refresh();
        return () => controller.abort();
      }, [sessionId, usage]);

      const summary = usageSummary(text);
      if (!summary) return null;
      const className = "agent-tools-usage-summary";
      return h("span", { className: "agent-tools-usage", "data-agent-tools-usage": "" },
        summary === text ? h("span", { className, title: text }, summary) : h("button", {
          type: "button", className, title: open ? undefined : text, "aria-expanded": open,
          onClick: () => setOpen((value) => !value), onBlur: () => setOpen(false),
          onKeyDown: (event) => { if (event.key === "Escape") setOpen(false); },
        }, summary),
        open && summary !== text ? h("span", { className: "agent-tools-usage-detail" }, text) : null);
    }

    function SessionUsage({ sessionId, useProjection }) {
      const model = useProjection("modelSelection");
      const usage = useProjection("tokenUsage");
      const selected = model?.next ?? model?.lastUsed;
      // Remount on a model/session change to hide old usage immediately and
      // cancel any outstanding read before starting another one.
      const key = JSON.stringify([sessionId, selected?.provider, selected?.model]);
      return h(Usage, { key, sessionId, usage });
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement("style");
          style.textContent = styles;
          document.head.append(style);
          return () => style.remove();
        });
        ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
          name: "conversation.composer.dock", id: "agent-tools-usage", order: 100,
        }, SessionUsage));
      },
    };
  },
});
