import { isAbsolute, join } from "node:path";
import { usageCliHome } from "./lib/cli-settings.mjs";
import { readTextIfExists } from "./lib/config.mjs";
import { copilotOutputSpeed } from "./lib/output-speed.mjs";
import { runUsageStatusline } from "./lib/statusline-command.mjs";

async function resolveContext({ model }) {
  const id = model?.id;
  if (typeof id !== "string" || !id) return;

  const env = process.env;
  // The environment configuration selects one provider for the whole process.
  if (env.COPILOT_PROVIDER_BASE_URL) {
    const key = env.COPILOT_PROVIDER_BEARER_TOKEN ||
      (!env.COPILOT_PROVIDER_API_KEY_COMMAND ? env.COPILOT_PROVIDER_API_KEY : "");
    return { providerName: "copilot", baseUrl: env.COPILOT_PROVIDER_BASE_URL, key };
  }

  // Copilot qualifies BYOK model IDs with the provider name.
  const separator = id.indexOf("/");
  if (separator < 1) return;
  const name = id.slice(0, separator);
  const file = env.COPILOT_PROVIDERS_CONFIG || join(usageCliHome("copilot"), "providers.json");
  const config = JSON.parse(await readTextIfExists(file) || "{}");
  if (!config.models?.some((entry) => entry.provider === name && entry.id === id.slice(separator + 1))) return;
  const provider = config.providers?.find((entry) => entry.name === name);
  return { providerName: name, baseUrl: provider?.baseUrl, key: provider?.bearerToken || provider?.apiKey };
}

function readSpeed({ transcript_path: transcript }) {
  if (typeof transcript !== "string" || !isAbsolute(transcript)) return "";
  return copilotOutputSpeed(join(transcript, "events.jsonl"));
}

await runUsageStatusline("copilot", resolveContext, readSpeed);
