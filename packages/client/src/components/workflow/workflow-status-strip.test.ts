import { describe, expect, it } from "vitest";
import {
  pinnedRunLabel,
  pinnedRunModeLabel,
} from "#src/components/workflow/workflow-status-strip";
import { generateId } from "@wfgraph/shared/utils/id";
import { formatExactTime } from "@wfgraph/shared/utils/time";
import { runShortId } from "#src/lib/workflow-run-labels";

describe("pinnedRunLabel", () => {
  // The ids this takes are what `generateId` produces: a 36-character UUIDv7,
  // whose leading characters repeat across runs minted around the same time.
  const runId = generateId();

  it("names the run by its short id and its start in the exact time format", () => {
    const startedAt = new Date(2026, 7, 2, 14, 32);

    expect(pinnedRunLabel({ id: runId, startedAt })).toBe(
      `${runShortId(runId)} · ${formatExactTime(startedAt)}`
    );
  });

  it("names the run alone when the payload's timestamp will not parse", () => {
    // `startedAt` crosses the wire as a plain string, and printing an invalid
    // date would put "Invalid Date" in the strip.
    expect(pinnedRunLabel({ id: runId, startedAt: null })).toBe(
      runShortId(runId)
    );
  });

  it("says nothing at all while the run's payload is in flight", () => {
    expect(pinnedRunLabel(undefined)).toBe("");
  });
});

describe("pinnedRunModeLabel", () => {
  it("labels a draft run as reaching test recipients", () => {
    expect(
      pinnedRunModeLabel({
        versionKind: "draft_snapshot",
        versionNumber: null,
        runMode: "test",
      })
    ).toBe("Draft · Test run");
  });

  it("labels a published run with its version and recipients", () => {
    expect(
      pinnedRunModeLabel({
        versionKind: "published",
        versionNumber: 7,
        runMode: "live",
      })
    ).toBe("v7 · Live run");
    expect(
      pinnedRunModeLabel({
        versionKind: "published",
        versionNumber: 7,
        runMode: "test",
      })
    ).toBe("v7 · Test run");
  });

  it("returns an empty label while the run's payload is loading", () => {
    expect(pinnedRunModeLabel(undefined)).toBe("");
  });

  it("returns an empty label for a published run with no version number", () => {
    // A published run always pins to a numbered version. This guards against a
    // stub or partly loaded payload printing "vnull".
    expect(
      pinnedRunModeLabel({
        versionKind: "published",
        versionNumber: null,
        runMode: "live",
      })
    ).toBe("");
  });
});
