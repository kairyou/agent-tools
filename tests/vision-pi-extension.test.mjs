import assert from "node:assert/strict";
import { test } from "node:test";

import piVisionExtension, { createPiVisionExtension } from "../dist/vision/pi-extension.mjs";

test("Pi extension registers inspect_image through the public extension API", () => {
  let registered;
  piVisionExtension({ registerTool(tool) { registered = tool; } });

  assert.equal(registered.name, "inspect_image");
  assert.equal(registered.label, "Inspect image");
  assert.equal(registered.parameters.type, "object");
  assert.equal(registered.parameters.properties.questions.maxItems, 20);
  assert.match(registered.description, /untrusted data/);
});

test("Pi extension delegates execution to the shared vision service", async () => {
  const expected = { request_id: "vision_req_test", answers: [{ id: "q1", answer: "42" }] };
  let input;
  let registered;
  const extension = createPiVisionExtension({
    createService: () => ({
      async inspect(value) {
        input = value;
        return expected;
      },
    }),
  });
  extension({ registerTool(tool) { registered = tool; } });

  const params = {
    image_source: { type: "file", value: "screen.png" },
    questions: [{ id: "q1", text: "What number is visible?" }],
  };
  const result = await registered.execute("call-1", params);
  assert.deepEqual(input, params);
  assert.deepEqual(result.details, expected);
  assert.equal(JSON.parse(result.content[0].text).answers[0].answer, "42");
});

test("Pi extension signals tool errors through its host contract", async () => {
  let registered;
  const extension = createPiVisionExtension({
    createService: () => ({
      async inspect() {
        throw new Error("unexpected failure");
      },
    }),
  });
  extension({ registerTool(tool) { registered = tool; } });

  await assert.rejects(
    registered.execute("call-1", {
      image_source: { type: "file", value: "screen.png" },
      questions: [{ id: "q1", text: "What is visible?" }],
    }),
    /^Error: \[internal_error\] unexpected failure$/
  );
});
