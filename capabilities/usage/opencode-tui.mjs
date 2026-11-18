import { readOpenCodeUsage } from "./lib/opencode-session.mjs";

const tui = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "agent-tools.usage",
        title: "Provider usage",
        category: "Agent Tools",
        namespace: "palette",
        slashName: "at-usage",
        async run() {
          const route = api.route.current;
          const directory = api.state.path.directory;
          const sessionID = route.name === "session" ? route.params.sessionID : "";
          const message = await readOpenCodeUsage(directory, sessionID);
          const current = api.route.current;
          if (current.name !== route.name || (current.name === "session" && current.params.sessionID !== sessionID) ||
              api.state.path.directory !== directory) return;
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
