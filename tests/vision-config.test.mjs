import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DEFAULTS, loadVisionConfig, resolveSecret } from "../lib/vision/config.mjs";

function writeConfig(vision) {
  const dir = mkdtempSync(join(tmpdir(), "at-vision-config-"));
  const file = join(dir, "config.jsonc");
  writeFileSync(file, typeof vision === "string" ? vision : JSON.stringify({ vision }, null, 2));
  return file;
}

const BASE = {
  provider: "openai-compatible",
  baseUrl: "https://gateway.example.com/v1",
  model: "internal-vlm",
  apiKey: "sk-literal",
};

test("loads a valid config and applies defaults", () => {
  const cfg = loadVisionConfig({ file: writeConfig(BASE), env: {} });
  assert.equal(cfg.provider, "openai-compatible");
  assert.equal(cfg.baseUrl, "https://gateway.example.com/v1");
  assert.equal(cfg.model, "internal-vlm");
  assert.equal(cfg.apiKey, "sk-literal");
  assert.equal(cfg.timeoutMs, CONFIG_DEFAULTS.timeoutMs);
  assert.equal(cfg.maxImageBytes, CONFIG_DEFAULTS.maxImageBytes);
  assert.equal(cfg.maxConcurrentRequests, CONFIG_DEFAULTS.maxConcurrentRequests);
  assert.equal(cfg.maxRequestsPerMinute, CONFIG_DEFAULTS.maxRequestsPerMinute);
});

test("accepts JSONC comments and trims trailing baseUrl slash", () => {
  const file = writeConfig(
    `{
      // user comment
      "vision": {
        "provider": "anthropic-compatible",
        "baseUrl": "https://gw.example.com/",
        "model": "vlm", // trailing comment
      },
    }`
  );
  const cfg = loadVisionConfig({ file, env: {} });
  assert.equal(cfg.baseUrl, "https://gw.example.com");
  assert.equal(cfg.apiKey, null);
});

test("resolves apiKey env reference from the named variable only", () => {
  const file = writeConfig({ ...BASE, apiKey: { env: "MY_VISION_KEY" } });
  const cfg = loadVisionConfig({ file, env: { MY_VISION_KEY: "from-env", OTHER: "no" } });
  assert.equal(cfg.apiKey, "from-env");
});

test("missing env variable fails with the variable name and no fallback", () => {
  const file = writeConfig({ ...BASE, apiKey: { env: "MISSING_VAR" } });
  assert.throws(
    () => loadVisionConfig({ file, env: { OPENAI_API_KEY: "should-not-be-used" } }),
    (err) => {
      assert.equal(err.code, "config_error");
      assert.match(err.message, /MISSING_VAR/);
      assert.doesNotMatch(err.message, /should-not-be-used/);
      return true;
    }
  );
});

test("resolveSecret rejects malformed references", () => {
  assert.throws(() => resolveSecret({ env: "" }, {}), /apiKey/);
  assert.throws(() => resolveSecret(42, {}), /apiKey/);
  assert.throws(() => resolveSecret("", {}), /empty string/);
  assert.equal(resolveSecret(undefined, {}), null);
});

test("rejects unknown provider and bad baseUrl", () => {
  assert.throws(
    () => loadVisionConfig({ file: writeConfig({ ...BASE, provider: "qwen" }), env: {} }),
    /provider must be one of/
  );
  assert.throws(
    () => loadVisionConfig({ file: writeConfig({ ...BASE, baseUrl: "ftp://x" }), env: {} }),
    /baseUrl/
  );
  for (const baseUrl of [
    "https://",
    "http://[::1",
    "https://user:pass@gateway.example.com/v1",
    "https://gateway.example.com/v1?tenant=x",
    "https://gateway.example.com/v1#fragment",
  ]) {
    assert.throws(
      () => loadVisionConfig({ file: writeConfig({ ...BASE, baseUrl }), env: {} }),
      /baseUrl/
    );
  }
});

test("missing vision section points at the config template", () => {
  assert.throws(() => loadVisionConfig({ file: writeConfig("{}"), env: {} }), (err) => {
    assert.equal(err.code, "config_error");
    assert.match(err.message, /"vision" section/);
    assert.match(err.message, /openai-compatible/);
    return true;
  });
});

test("maxRequestsPerMinute accepts 0 (disabled); others must be positive", () => {
  const okZero = loadVisionConfig({
    file: writeConfig({ ...BASE, maxRequestsPerMinute: 0 }),
    env: {},
  });
  assert.equal(okZero.maxRequestsPerMinute, 0);
  assert.throws(
    () => loadVisionConfig({ file: writeConfig({ ...BASE, maxConcurrentRequests: 0 }), env: {} }),
    /maxConcurrentRequests/
  );
  assert.throws(
    () => loadVisionConfig({ file: writeConfig({ ...BASE, timeoutMs: -1 }), env: {} }),
    /timeoutMs/
  );
});
