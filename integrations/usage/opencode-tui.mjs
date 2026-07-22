import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_TOOLS_HOME = process.env.AGENT_TOOLS_HOME || join(homedir(), ".agent-tools");
const SNAPSHOT_PATH = join(AGENT_TOOLS_HOME, "cache", "usage-snapshot.json");

function latestUsage() {
  try {
    const data = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    return Object.values(data?.items || {})
      .filter((item) => typeof item?.text === "string" && item.text)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0]?.text || "";
  } catch {
    return "";
  }
}

const tui = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "agent-tools.usage",
        title: "Provider usage",
        category: "Agent Tools",
        namespace: "palette",
        slashName: "at-usage",
        run() {
          const message = latestUsage();
          api.ui.toast({
            title: "Provider usage",
            message: message || "Provider usage is not available yet",
            variant: message ? "info" : "warning",
            duration: 8000,
          });
        },
      },
    ],
  });
};

export default {
  id: "agent-tools-usage",
  tui,
};
