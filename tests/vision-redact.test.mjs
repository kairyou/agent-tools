import assert from "node:assert/strict";
import { test } from "node:test";
import { redactDeep, redactSecrets } from "../lib/vision/redact.mjs";

test("redactSecrets masks every occurrence of each secret", () => {
  const out = redactSecrets("Bearer sk-abc123 then sk-abc123 again, plus other-key", [
    "sk-abc123",
    "other-key",
  ]);
  assert.equal(out, "Bearer *** then *** again, plus ***");
});

test("redactSecrets ignores empty and non-string secrets", () => {
  assert.equal(redactSecrets("keep me", ["", null, undefined]), "keep me");
  assert.equal(redactSecrets("", ["x"]), "");
});

test("redactDeep masks secrets nested in objects and arrays", () => {
  const out = redactDeep(
    { msg: "key sk-1 leaked", list: ["sk-1", { deep: "prefix sk-1 suffix" }], n: 7 },
    ["sk-1"]
  );
  assert.deepEqual(out, { msg: "key *** leaked", list: ["***", { deep: "prefix *** suffix" }], n: 7 });
});
