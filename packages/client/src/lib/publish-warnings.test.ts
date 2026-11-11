import { describe, expect, it } from "vitest";
import { publishWarningMessage } from "#src/lib/publish-warnings";

describe("publishWarningMessage", () => {
  it("names the runs an identity form change leaves on their version, in the form each side uses", () => {
    expect(
      publishWarningMessage({
        code: "entity_tracking_changed",
        tracksEntity: true,
        inFlightRuns: 3,
      })
    ).toEqual({
      title: "3 runs started by an earlier version",
      description:
        "This version tracks an Entity. The 3 runs still in flight from an earlier version identify their Entity by its Correlation Path value, so they finish on that version and cannot be migrated. Cancel Events and Concurrency still reach them.",
    });
    expect(
      publishWarningMessage({
        code: "entity_tracking_changed",
        tracksEntity: false,
        inFlightRuns: 1,
      }).description
    ).toBe(
      "This version no longer tracks an Entity. The 1 run still in flight from an earlier version identifies its Entity by its type and ID, so it finishes on that version and cannot be migrated. Cancel Events and Concurrency still reach it."
    );
  });
});
