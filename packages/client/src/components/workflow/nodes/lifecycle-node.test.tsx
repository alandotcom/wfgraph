import { describe, expect, it } from "vitest";
import { getStartSummary } from "#src/components/workflow/nodes/lifecycle-node";

describe("getStartSummary", () => {
  // A workflow the panel has never touched is one the Run button starts, so the
  // canvas has to say so rather than contradict the button beside it.
  it("says manual runs for a node carrying no rules at all", () => {
    expect(getStartSummary(undefined)).toBe("Manual runs only");
    expect(getStartSummary({})).toBe("Manual runs only");
  });

  it("names the one Start Event when there is one", () => {
    expect(
      getStartSummary({
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: "unlimited",
        },
      })
    ).toBe("On app/appointment.created");
  });

  it("counts the Start Events when there are several", () => {
    expect(
      getStartSummary({
        lifecycleRules: {
          startEvents: ["app/appointment.created", "app/appointment.canceled"],
          cancelEvents: [],
          concurrency: "newest-wins",
        },
      })
    ).toBe("On 2 events");
  });

  // Rules that exist and leave every start source out are a decision, and the
  // canvas is where a builder finds out they made it.
  it("says nothing starts a workflow whose rules allow nothing", () => {
    expect(
      getStartSummary({
        lifecycleRules: {
          startEvents: [],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: false,
        },
      })
    ).toBe("Nothing starts this yet");
  });
});
