import { describe, expect, it } from "vitest";
import { pinnedRunLabel } from "#src/components/workflow/workflow-status-strip";
import { generateId } from "@wfgraph/shared/utils/id";

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
