import { queryCachedProviderUsage } from "./core.mjs";
import { usageAccountCacheKey } from "./lib/cache-policy.mjs";
import { agentConfig, REFRESH_INTERVAL_MS } from "./lib/config.mjs";
import { usageContext } from "./lib/context.mjs";
import { withOutputSpeed } from "./lib/output-speed.mjs";
import { usageSummary } from "./lib/usage-summary.mjs";

const ITEM = "gateway-usage";
const REFRESH = "refresh-usage";

// ZCode's composer slot accepts up to 40 characters of text and 200 in the tooltip.
function shorten(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function modelKey(model) {
  return model && JSON.stringify([model.providerId, model.modelId]);
}

export function createZcodeUsageExtension() {
  let dispose;
  return {
    activate(ctx) {
      dispose?.();
      let active = true;
      const sessions = new Map();

      function publish(sessionId, { text = "", output } = {}) {
        const summary = withOutputSpeed(usageSummary(text), output?.speed);
        const tooltip = withOutputSpeed(text, output?.speed);
        ctx.slots.update(ITEM, {
          text: summary ? shorten(summary, 40) : null,
          tooltip: tooltip ? shorten(tooltip, 200) : null,
        }, { sessionId });
      }

      async function update(sessionId, state, force = false) {
        const revision = ++state.revision;
        const isCurrent = () => active && sessions.get(sessionId) === state && state.revision === revision;
        const getModel = async () => (await ctx.context.get({ sessionId }))?.model;
        try {
          const model = await getModel();
          const providerId = model?.providerId;
          // An unknown session selection must not be substituted with a different account.
          const context = providerId && await usageContext("zcode", { providerId });
          const account = context ? usageAccountCacheKey(context) : "";
          if (!isCurrent()) return;
          const key = modelKey(model);
          if (state.model !== key || state.account !== account) {
            if (state.output?.model !== key) state.output = undefined;
            if (state.account !== account) state.text = "";
            state.model = key;
            state.account = account;
            publish(sessionId, state);
          }
          if (!account) return;
          const text = await queryCachedProviderUsage(context, { agent: "zcode", force });
          if (!isCurrent()) return;
          const currentProvider = (await getModel())?.providerId;
          const current = currentProvider && await usageContext("zcode", { providerId: currentProvider });
          if (!isCurrent()) return;
          state.text = current && usageAccountCacheKey(current) === account ? text : "";
          publish(sessionId, state);
        } catch {
          if (!isCurrent()) return;
          state.text = "";
          publish(sessionId, state);
        }
      }

      const subscriptions = [
        ctx.commands.register(REFRESH, ({ scope }) => {
          const state = scope.kind === "session" && sessions.get(scope.sessionId);
          if (state) return update(scope.sessionId, state, true);
        }),
        ctx.context.onDidChange(({ sessionId }) => {
          const state = sessions.get(sessionId);
          if (state) void update(sessionId, state);
        }),
        // The host sends the current visible-session list as the first event.
        ctx.workbench.onDidChange(({ sessions: visible }) => {
          const ids = new Set(visible.map(({ sessionId }) => sessionId));
          for (const sessionId of sessions.keys()) {
            if (!ids.has(sessionId)) {
              sessions.delete(sessionId);
              publish(sessionId);
            }
          }
          for (const sessionId of ids) {
            if (sessions.has(sessionId)) continue;
            const state = { revision: 0 };
            sessions.set(sessionId, state);
            void update(sessionId, state);
          }
        }),
      ];
      void agentConfig().then(({ outputSpeed }) => {
        if (!active || outputSpeed !== true || !ctx.models?.onDidGenerate) return;
        subscriptions.push(ctx.models.onDidGenerate(({ sessionId, phase, model, outputTokens, outputTokensPerSecond }) => {
          const state = sessions.get(sessionId);
          const key = modelKey(model);
          // The host's streaming events estimate tokens from characters.
          if (!state || phase !== "final" || (state.model && state.model !== key) ||
              !Number.isSafeInteger(outputTokens) || outputTokens <= 0 ||
              !Number.isFinite(outputTokensPerSecond) || outputTokensPerSecond <= 0) return;
          state.output = { model: key, speed: `${outputTokensPerSecond.toFixed(1)} tok/s` };
          publish(sessionId, state);
        }));
      });
      const timer = setInterval(() => {
        for (const [sessionId, state] of sessions) void update(sessionId, state);
      }, REFRESH_INTERVAL_MS);
      timer.unref?.();
      dispose = () => {
        active = false;
        clearInterval(timer);
        for (const subscription of subscriptions) subscription.dispose();
        sessions.clear();
      };
    },
    deactivate() {
      dispose?.();
      dispose = undefined;
    },
  };
}

export const { activate, deactivate } = createZcodeUsageExtension();
