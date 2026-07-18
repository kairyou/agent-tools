// OpenAI-compatible adapter (Chat Completions with image_url content parts).
// Convention: vision.baseUrl includes the version prefix, e.g.
// https://gateway.example.com/v1 — the adapter appends /chat/completions.

import { ERROR_CODES, VisionError } from "../errors.mjs";
import { buildPrompt, normalizeAnswers, postJson } from "./shared.mjs";

function replyText(json) {
  const message = json?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return null;
}

export async function inspectWithOpenAICompatible({ config, image, questions, fetchImpl }) {
  const headers = {};
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const body = {
    model: config.model,
    // Gateway defaults vary and can silently truncate long transcriptions.
    max_tokens: config.maxOutputTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(questions) },
          {
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.bytes.toString("base64")}` },
          },
        ],
      },
    ],
  };
  const json = await postJson({
    url: `${config.baseUrl}/chat/completions`,
    headers,
    body,
    timeoutMs: config.timeoutMs,
    fetchImpl,
    providerLabel: "OpenAI-compatible provider",
  });
  const text = replyText(json);
  if (text === null) {
    throw new VisionError(
      ERROR_CODES.PROVIDER_RESPONSE,
      "OpenAI-compatible provider response has no choices[0].message.content."
    );
  }
  return normalizeAnswers(text, questions);
}
