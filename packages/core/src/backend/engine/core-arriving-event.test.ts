/**
 * The Arriving Event is carried per branch. The cases are declared in
 * `core-arriving-event.replay-cases.ts`, so the replay suite runners can run
 * them on a real database too.
 */

import { describe } from "vitest";
import { defineArrivingEventReplayCases } from "#src/backend/engine/core-arriving-event.replay-cases";

describe("Arriving Event per branch", () => {
  defineArrivingEventReplayCases({});
});
