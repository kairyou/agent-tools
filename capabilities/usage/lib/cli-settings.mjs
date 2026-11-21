import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function usageCliHome(agent) {
  const home = homedir();
  const configured = process.env[agent === "copilot" ? "COPILOT_HOME" : "QWEN_HOME"]?.trim();
  if (!configured) return join(home, `.${agent}`);
  if (agent === "qwen" && /^~(?:[/\\]|$)/.test(configured)) return resolve(home, configured.slice(2));
  return resolve(configured);
}
