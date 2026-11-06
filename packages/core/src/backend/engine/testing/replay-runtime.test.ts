/**
 * Coverage for the replay driver itself, so the engine tests that stand on it
 * are standing on a stated model rather than on an assumption: a parked pass
 * ends the body, and the run wakes when any one of its parks resolves. The
 * driver's cases live in `replay-runtime.replay-cases.ts` so the replay suite
 * runners can run them on a real database too.
 */

import { describe, expect, it } from "vitest";
import type { WaitWake } from "#src/backend/engine/runtime";
import {
  createInMemoryReplayBackend,
  driveWithReplay,
  type ReplayDatabaseBackend,
} from "#src/backend/engine/testing/replay-runtime";
import {
  defineReplayRuntimeCases,
  isParked,
  PARK_ROWS,
  PARKED_PASS,
  park,
} from "#src/backend/engine/testing/replay-runtime.replay-cases";

describe("driveWithReplay", () => {
  defineReplayRuntimeCases({});
});

describe("driveWithReplay backends", () => {
  it("runs each pass against the runtime the backend supplies, and records each wake there", async () => {
    const memory = createInMemoryReplayBackend();
    const passes: number[] = [];
    const resolved: Array<{ stepId: string; wake: WaitWake }> = [];
    const backend: ReplayDatabaseBackend = {
      runtimeForPass: (pass) => {
        passes.push(pass.invocation);
        return memory.runtimeForPass(pass);
      },
      wakePark: (stepId, wake, at) => {
        resolved.push({ stepId, wake });
        return memory.wakePark(stepId, wake, at);
      },
    };

    const run = await driveWithReplay(
      async (runtime) =>
        isParked(await park(runtime, "nap", 1_000)) ? PARKED_PASS : "done",
      { executor: { openBackend: () => backend }, waitRows: PARK_ROWS }
    );

    expect(run.value).toBe("done");
    expect(passes).toEqual([0, 1]);
    expect(resolved).toEqual([{ stepId: "nap", wake: { kind: "timeout" } }]);
  });

  it("answers a park the backend has no wake for as parked", async () => {
    const runtime = await createInMemoryReplayBackend().runtimeForPass({
      invocation: 0,
      now: 0,
      parkDeadline: () => 1_000,
    });

    await expect(park(runtime, "nap", 1_000)).resolves.toEqual({
      kind: "parked",
    });
  });
});
