/**
 * A host action's handler across the passes of a run. The cases live in
 * `host-action-memo.replay-cases.ts`, so the replay suite runners can run them
 * on a real database too.
 */

import { describe } from "vitest";
import { defineHostActionMemoReplayCases } from "#src/backend/engine/host-action-memo.replay-cases";

describe("host action handler across passes", () => {
  defineHostActionMemoReplayCases({});
});
