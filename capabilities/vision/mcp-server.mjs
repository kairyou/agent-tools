#!/usr/bin/env node
// Vision MCP stdio server. Thin shell over ./lib: registers the
// inspect_image tool, translates results/errors, and nothing else. Launched by
// hosts as `agent-tools mcp-vision` (or `node capabilities/vision/mcp-server.mjs`).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createVisionService, QUESTION_LIMITS } from "./lib/inspect.mjs";
import { isVisionError } from "./lib/errors.mjs";
import { VISION_TOOL_DESCRIPTION, VISION_TOOL_NAME } from "./lib/tool-contract.mjs";

// Stable soft constraints live here: this text follows the tool into every
// session, whether or not the at-vision skill is loaded.
const INPUT_SCHEMA = {
  image_source: z
    .object({
      type: z.enum(["file", "url"]).describe("file = local image path, url = http(s) image URL"),
      value: z.string().min(1).describe("Absolute/relative file path, or http(s) URL"),
    })
    .describe("The image to inspect. Exactly one concrete image; no globs or directories."),
  questions: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(QUESTION_LIMITS.maxIdLength)
          .describe("Caller-chosen id echoed back in the matching answer"),
        text: z
          .string()
          .min(1)
          .max(QUESTION_LIMITS.maxTextLength)
          .describe("One narrow, factual question about the image"),
      })
    )
    .min(1)
    .max(QUESTION_LIMITS.maxCount)
    .describe("Questions answered strictly from the image pixels."),
};

function errorResult(err) {
  const code = isVisionError(err) ? err.code : "internal_error";
  return {
    content: [{ type: "text", text: `[${code}] ${err.message}` }],
    isError: true,
  };
}

// Config problems must not kill the server: keep serving tool discovery and
// return actionable errors per call, retrying config until the user fixes it.
let service = null;
function getService() {
  if (!service) service = createVisionService();
  return service;
}

const server = new McpServer(
  { name: "agent-tools-vision", version: "1.0.0" },
  {
    instructions:
      "Use inspect_image when the user's task depends on visible content and only an image path or URL is available, direct inspection failed, or the user explicitly requests the provider. " +
      "If the prompt already contains actual image content or a host image viewer returned it, use that content directly. " +
      "It is a callable MCP tool, not an MCP resource; call it directly and never use list_mcp_resources or read_mcp_resource for images. " +
      "A bare path or URL without a visual task is not a reason to call it. " +
      "Never use the provider when the user prohibits it, or for file operations that do not require image content. " +
      "For mockups/documents/charts, one question asking for a structured transcription (HTML skeleton / Markdown / data table) beats many fragments.",
  }
);

server.registerTool(
  VISION_TOOL_NAME,
  {
    title: "Inspect image",
    description:
      `${VISION_TOOL_DESCRIPTION} This is a callable MCP tool, not an MCP resource. ` +
      "Invoke it directly; never use list_mcp_resources or read_mcp_resource, and never treat inspect_image as a resource URI.",
    inputSchema: INPUT_SCHEMA,
  },
  async ({ image_source, questions }) => {
    try {
      const result = await getService().inspect({ image_source, questions });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
