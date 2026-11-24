import { useAgent } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { createElement as h, useEffect, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { usageSummary } from "./lib/usage-summary.mjs";
import { agentUsage } from "./paseo-rpc.mjs";

const empty = { gateway: "", speed: "" };

function addUsagePill(client, { id: agentId, workspaceId }) {
  let usage = empty;
  const listeners = new Set();
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const current = () => usage;

  function publish(next) {
    if (next.gateway === usage.gateway && next.speed === usage.speed) return;
    usage = next;
    const label = [usageSummary(next.gateway), next.speed].filter(Boolean).join(" | ");
    pill.update({ label: label || "Usage" });
    for (const listener of listeners) listener();
  }

  function UsageIcon({ size, color }) {
    const state = useAgent(agentId, ({ status, runtimeInfo }) => ({ status, sessionId: runtimeInfo?.sessionId }));
    useEffect(() => {
      let stopped = false;
      void client.rpc(agentUsage, { agentId }).then((next) => {
        if (!stopped) publish(next);
      }).catch(() => {});
      return () => { stopped = true; };
    }, [state?.status, state?.sessionId]);
    return h(Icon, { name: "Gauge", size, color });
  }

  function UsageDetails({ theme }) {
    const { gateway, speed } = useSyncExternalStore(subscribe, current);
    const details = [gateway, speed].filter(Boolean).join("\n");
    return h(Text, { selectable: true, style: { color: theme.colors.foreground } }, details || "Usage is unavailable.");
  }

  const pill = client.addComposerPill({
    id: "gateway-usage", workspaceId, agentId,
    button: { title: "Gateway usage", label: "Usage", icon: UsageIcon, behavior: { kind: "popover", Content: UsageDetails } },
  });
  return pill;
}

export default function contribute(client) {
  const lifetime = new AbortController();
  const agents = new Map();
  const remove = (id) => {
    agents.get(id)?.pill?.remove();
    agents.delete(id);
  };

  function update(agent) {
    if (!agent.workspaceId || agent.archivedAt || lifetime.signal.aborted) {
      remove(agent.id);
      return;
    }
    const previous = agents.get(agent.id);
    const target = JSON.stringify([agent.workspaceId, agent.provider, agent.runtimeInfo?.sessionId]);
    if (previous?.target === target && (previous.pill || previous.status === agent.status)) return;
    remove(agent.id);
    const state = { target, status: agent.status };
    agents.set(agent.id, state);
    void client.rpc(agentUsage, { agentId: agent.id, check: true }).then(({ available }) => {
      if (available && agents.get(agent.id) === state) state.pill = addUsagePill(client, agent);
    }).catch(() => {});
  }

  void client.paseo.agents.list({ filter: { includeArchived: false }, subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) return subscription.release();
    subscription.subscribe({
      snapshot({ entries }) {
        const active = new Set(entries.map(({ agent }) => agent.id));
        for (const id of agents.keys()) if (!active.has(id)) remove(id);
        for (const { agent } of entries) update(agent);
      },
      update(message) {
        if (message.type !== "agent_update") return;
        const event = message.payload;
        if (event.kind === "remove") remove(event.agentId);
        else if (event.kind === "upsert") update(event.agent);
      },
    });
  }).catch(() => {});

  return () => {
    lifetime.abort();
    for (const id of agents.keys()) remove(id);
  };
}
