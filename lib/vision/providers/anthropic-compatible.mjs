// Anthropic-compatible adapter (Messages API with base64 image blocks).
// Convention: vision.baseUrl is the gateway root, e.g.
// https://gateway.example.com — the adapter appends /v1/messages (or just
// /messages when the base already ends in /v1).

import { ERROR_CODES, VisionError } from "../errors.mjs";
import { buildPrompt, normalizeAnswers, postJson } from "./shared.mjs";

function messagesUrl(baseUrl) {
  return baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
}

function replyText(json) {
  if (!Array.isArray(json?.content)) return null;
  const parts = json.content.filter((p) => p?.type === "text" && typeof p.text === "string");
  if (parts.length === 0) return null;
  return parts.map((p) => p.text).join("");
}

export async function inspectWithAnthropicCompatible({ config, image, questions, fetchImpl }) {
  const headers = { "anthropic-version": "2023-06-01" };
  if (config.apiKey) headers["x-api-key"] = config.apiKey;
  const body = {
    model: config.model,
    max_tokens: config.maxOutputTokens,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.bytes.toString("base64"),
            },
          },
          { type: "text", text: buildPrompt(questions) },
        ],
      },
    ],
  };
  const json = await postJson({
    url: messagesUrl(config.baseUrl),
    headers,
    body,
    timeoutMs: config.timeoutMs,
    fetchImpl,
    providerLabel: "Anthropic-compatible provider",
  });
  const text = replyText(json);
  if (text === null) {
    throw new VisionError(
      ERROR_CODES.PROVIDER_RESPONSE,
      "Anthropic-compatible provider response has no text content blocks."
    );
  }
  return normalizeAnswers(text, questions);
}
