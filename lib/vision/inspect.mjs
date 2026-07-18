// Orchestrator shared by the MCP server and the diagnostic CLI. Owns question
// validation, the process-local limiter, provider dispatch, and final secret
// redaction — both entry points stay thin.

import crypto from "node:crypto";
import { loadVisionConfig } from "./config.mjs";
import { ERROR_CODES, VisionError, toVisionError } from "./errors.mjs";
import { loadImageSource } from "./image-source.mjs";
import { createLimiter } from "./rate-limit.mjs";
import { redactSecrets } from "./redact.mjs";
import { inspectWithAnthropicCompatible } from "./providers/anthropic-compatible.mjs";
import { inspectWithOpenAICompatible } from "./providers/openai-compatible.mjs";

const PROVIDER_IMPL = {
  "openai-compatible": inspectWithOpenAICompatible,
  "anthropic-compatible": inspectWithAnthropicCompatible,
};

export const QUESTION_LIMITS = Object.freeze({
  maxCount: 20,
  maxIdLength: 64,
  maxTextLength: 4000,
});

export function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new VisionError(
      ERROR_CODES.INPUT,
      'questions must be a non-empty array of { "id": "<id>", "text": "<question>" }.'
    );
  }
  if (questions.length > QUESTION_LIMITS.maxCount) {
    throw new VisionError(
      ERROR_CODES.INPUT,
      `questions must contain at most ${QUESTION_LIMITS.maxCount} entries.`
    );
  }
  const seen = new Set();
  const out = [];
  for (const q of questions) {
    if (!q || typeof q !== "object" || typeof q.id !== "string" || q.id.trim() === "" ||
        typeof q.text !== "string" || q.text.trim() === "") {
      throw new VisionError(
        ERROR_CODES.INPUT,
        'Each question must be { "id": "<non-empty id>", "text": "<non-empty question>" }.'
      );
    }
    if (q.id.length > QUESTION_LIMITS.maxIdLength) {
      throw new VisionError(
        ERROR_CODES.INPUT,
        `Question id must be at most ${QUESTION_LIMITS.maxIdLength} characters.`
      );
    }
    if (q.text.length > QUESTION_LIMITS.maxTextLength) {
      throw new VisionError(
        ERROR_CODES.INPUT,
        `Question text must be at most ${QUESTION_LIMITS.maxTextLength} characters.`
      );
    }
    if (seen.has(q.id)) {
      throw new VisionError(ERROR_CODES.INPUT, `Duplicate question id: ${q.id}`);
    }
    seen.add(q.id);
    out.push({ id: q.id, text: q.text });
  }
  return out;
}

// One service per process: the limiter state must span all tool calls handled
// by this MCP server (or CLI invocation).
export function createVisionService({ config, fetchImpl, now } = {}) {
  const resolved = config || loadVisionConfig();
  const limiter = createLimiter(resolved, now);
  const provider = PROVIDER_IMPL[resolved.provider];
  const secrets = resolved.apiKey ? [resolved.apiKey] : [];

  async function inspect({ image_source, questions }) {
    const requestId = `vision_req_${crypto.randomUUID().slice(0, 8)}`;
    const validQuestions = validateQuestions(questions);
    try {
      return await limiter.run(async () => {
        const image = await loadImageSource(image_source, {
          maxImageBytes: resolved.maxImageBytes,
          timeoutMs: resolved.timeoutMs,
          fetchImpl,
        });
        const answers = await provider({ config: resolved, image, questions: validQuestions, fetchImpl });
        return { request_id: requestId, answers };
      });
    } catch (err) {
      // Last-line defense: no output path may carry the resolved key.
      const visionErr = toVisionError(err);
      visionErr.message = redactSecrets(visionErr.message, secrets);
      throw visionErr;
    }
  }

  return { config: resolved, inspect };
}
