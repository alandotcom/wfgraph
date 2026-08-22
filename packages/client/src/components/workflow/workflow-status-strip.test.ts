import { describe, expect, it } from "vitest";
import {
  pinnedRunLabel,
  workflowModeLabel,
} from "#src/components/workflow/workflow-status-strip";
import { generateId } from "@wfgraph/shared/utils/id";

describe("workflowModeLabel", () => {
  it("names test mode, which decides whether real email and SMS go out", () => {
    expect(workflowModeLabel("test")).toBe("Test mode");
  });

  it("names live mode too, rather than leaving the strip blank", () => {
    // The toolbar's old pill appeared only in test mode, so a builder reading
    // nothing could not tell live mode from a chrome that had not loaded. What
    // covers the not-loaded case now is the strip declining to render this at
    // all until the workflow payload has arrived.
    expect(workflowModeLabel("live")).toBe("Live mode");
  });
});

describe("pinnedRunLabel", () => {
  // The ids this takes are what `generateId` produces: 21 characters of
  // lowercase base-36, no prefix and no separator.
  const runId = generateId();

  it("shortens the run id to a fixed width and says when the run started", () => {
    const label = pinnedRunLabel({
      id: runId,
      startedAt: new Date(2026, 7, 2, 14, 32),
    });

    expect(label).toBe(`${runId.slice(0, 8)} · 02 Aug, 14:32`);
  });

  it("holds its width across ids and dates, so the row cannot reflow", () => {
    const first = pinnedRunLabel({
      id: generateId(),
      startedAt: new Date(2026, 7, 2, 14, 32),
    });
    const second = pinnedRunLabel({
      id: generateId(),
      startedAt: new Date(2026, 10, 30, 9, 5),
    });

    expect(second.length).toBe(first.length);
  });

  it("names the run alone when the payload's timestamp will not parse", () => {
    // `startedAt` crosses the wire as a plain string. Printing the parts of an
    // invalid date would put "NaN undefined, NaN:NaN" in the strip.
    expect(pinnedRunLabel({ id: runId, startedAt: null })).toBe(
      runId.slice(0, 8)
    );
  });

  it("says nothing at all while the run's payload is in flight", () => {
    expect(pinnedRunLabel(undefined)).toBe("");
  });
});
