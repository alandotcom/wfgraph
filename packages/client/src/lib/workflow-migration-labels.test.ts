import { describe, expect, it } from "vitest";
import {
  migrationOutcomeToast,
  migrationRefusalSentence,
  runCountLabel,
} from "#src/lib/workflow-migration-labels";

/**
 * These cases cover the wording a Migration is read by. They catch a sentence
 * that drops the target version number or the detail a refusal carries.
 */
describe("migrationRefusalSentence", () => {
  it("names the target version for a Wait the target graph does not have", () => {
    expect(migrationRefusalSentence({ reason: "wait_node_missing" }, 8)).toBe(
      "The Wait this run is parked on is not in version 8."
    );
  });

  it("tells the reader to ask again once a running run parks", () => {
    expect(migrationRefusalSentence({ reason: "executing" }, 8)).toBe(
      "Not parked on a Wait. Try again once the run reaches one."
    );
  });

  it("explains a target node that would run before the parked Wait", () => {
    expect(
      migrationRefusalSentence(
        { reason: "node_added_above_wait", detail: "added_1" },
        8
      )
    ).toBe("Version 8 adds a node that would run before this run's Wait.");
  });

  it("explains two Waits the target version places one below the other", () => {
    expect(
      migrationRefusalSentence({ reason: "waits_nested", detail: "wait_1" }, 8)
    ).toBe("Version 8 places one of this run's Waits below another.");
  });

  it("quotes the node and field an unresolved reference is about", () => {
    expect(
      migrationRefusalSentence(
        { reason: "unresolved_reference", detail: "after_1.subject" },
        8
      )
    ).toBe(
      "A field below the Wait reads an output this run never produced (after_1.subject)."
    );
  });

  it("drops the parenthetical when the refusal carries no detail", () => {
    expect(
      migrationRefusalSentence({ reason: "unresolved_reference" }, 8)
    ).toBe("A field below the Wait reads an output this run never produced.");
  });

  it("explains a run pinned to a draft", () => {
    expect(migrationRefusalSentence({ reason: "draft_run" }, 8)).toBe(
      "This run is on a draft."
    );
  });

  it("explains a Wait whose new timeout has already passed", () => {
    expect(
      migrationRefusalSentence({ reason: "wait_timeout_elapsed" }, 8)
    ).toBe("The Wait in version 8 would time out at once for this run.");
  });

  it("explains an outcome the migrate call refused after the preview", () => {
    expect(
      migrationRefusalSentence({ reason: "not_requested_version" }, 8)
    ).toBe("This run moved or ended before the migration reached it.");
  });
});

describe("runCountLabel", () => {
  it("uses the singular for one run", () => {
    expect(runCountLabel(1)).toBe("1 run");
    expect(runCountLabel(0)).toBe("0 runs");
    expect(runCountLabel(4)).toBe("4 runs");
  });
});

describe("migrationOutcomeToast", () => {
  it("counts the runs that moved and leaves out the second line", () => {
    expect(migrationOutcomeToast({ migrated: 2, notMoved: 0 })).toEqual({
      title: "Migrated 2 runs",
    });
  });

  it("counts every run that stayed where it was", () => {
    expect(migrationOutcomeToast({ migrated: 1, notMoved: 3 })).toEqual({
      title: "Migrated 1 run",
      description: "3 runs did not move.",
    });
  });
});
