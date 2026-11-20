import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const agentUsage = defineRpc({
  name: "agent-tools.usage",
  input: z.object({ agentId: z.string().min(1).max(256), check: z.boolean().optional() }),
  output: z.object({ available: z.boolean(), gateway: z.string(), speed: z.string() }),
});
