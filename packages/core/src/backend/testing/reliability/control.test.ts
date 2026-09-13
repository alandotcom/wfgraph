import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { boundary, eventually } from "#src/backend/testing/reliability/control";

describe("reliability repository boundaries", () => {
  test("a lost response preserves the committed write and fails only once", async () => {
    const fault = boundary();
    fault.arm({ fail: true, hold: true });
    let writes = 0;
    const operation = Effect.sync(() => ++writes);
    const first = Effect.runPromiseExit(fault.apply(operation, "after"));
    await fault.reached;
    expect(writes).toBe(1);
    expect(await Effect.runPromise(fault.apply(operation, "after"))).toBe(2);
    fault.release();
    expect((await first)._tag).toBe("Failure");
    expect(fault.hits).toBe(1);
    expect(writes).toBe(2);
  });
  test("a failure before a write leaves storage unchanged and permits retry", async () => {
    const fault = boundary();
    fault.arm({ fail: true, hold: false });
    let writes = 0;
    const operation = Effect.sync(() => ++writes);
    expect(
      (await Effect.runPromiseExit(fault.apply(operation, "before")))._tag
    ).toBe("Failure");
    expect(writes).toBe(0);
    expect(await Effect.runPromise(fault.apply(operation, "before"))).toBe(1);
  });
  test("a released pause forwards the actual repository answer", async () => {
    const fault = boundary();
    fault.arm({ fail: false, hold: true });
    let writes = 0;
    const pending = Effect.runPromise(
      fault.apply(
        Effect.sync(() => ++writes),
        "before"
      )
    );
    await fault.reached;
    expect(writes).toBe(0);
    fault.release();
    expect(await pending).toBe(1);
  });
  test("a missing observable condition fails rather than passing without progress", async () => {
    await expect(
      eventually(
        "not reached",
        async () => 0,
        (value) => value === 1,
        0
      )
    ).rejects.toThrow("Timed out: not reached");
  });
});
