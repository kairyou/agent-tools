import { expect, mock, test } from "claude-code/testing";

const band = {
  plugin: "agent-tools-desktop-usage", surface: "desktop", component: "AbovePrompt",
  viewport: { columns: 100, rows: 30 }, props: {},
} as const;

for (const mode of ["ready", "rejected", "pending"] as const) {
  test(`Desktop quota refresh with a ${mode} session ID`, async ($, on) => {
    const clock = mock.clock(on);
    const calls: string[][] = [];
    let sessionCalls = 0;
    on("session.id", () => {
      sessionCalls++;
      if (mode === "rejected") throw new Error("Session ID unavailable");
      if (mode === "pending") return new Promise(() => {});
      return { value: "resumed-session" };
    });
    on("process.run", (_$, event) => {
      const args = event.argv.slice(2);
      calls.push(args);
      const data = args[0] === "--settings"
        ? { outputSpeed: true, routed: true } : { gateway: "", routed: true };
      return { value: {
        exitCode: 0, stdout: JSON.stringify(data), stderr: "",
        isStdoutTruncated: false, isStderrTruncated: false,
      } };
    });
    on("ui.invalidate", () => ({ value: undefined }));
    on("turn.step", async function* (_$, event) {
      yield { kind: "text", index: 0, text: "ok" };
      await clock.sleep(800);
      return {
        turnId: event.turnId, index: event.index, answer: "ok", toolUses: [], stopReason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    });
    on("turn.complete", (_$, event) => ({ text: event.answer }));

    const initial = await $.ui.mount(band);
    await clock.settle();
    await initial.unmount();
    expect(calls).toEqual([["--settings"], []]);
    expect(sessionCalls).toBe(0);
    const stream = $.turn.step({ turnId: "turn", index: 0, model: "claude-test", messageCount: 1 });
    expect((await stream.next()).done).toBe(false);
    const finished = stream.next();
    await clock.settle();
    await clock.advance(800);
    expect((await finished).done).toBe(true);

    const completing = $.turn.complete({
      turnId: "turn", answer: "ok", durationMs: 800, isAborted: false, reason: "answer",
    });
    await clock.settle();
    const rendered = await $.ui.mount(band);
    expect(await rendered.find({ type: "Text", text: "50.0 tok/s" })).toBeDefined();
    await rendered.unmount();
    await clock.advance(250);
    expect((await completing).text).toBe("ok");
    await clock.settle();
    expect(sessionCalls).toBe(1);
    expect(calls).toEqual([["--settings"], [], mode === "ready" ? ["--session-id", "resumed-session"] : []]);
  });
}
