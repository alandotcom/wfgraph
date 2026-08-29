/**
 * The words a run is said in, both before it starts and after.
 *
 * Every surface offering a run reads its verb from here -- the toolbar's split
 * button, the Actions menu, the command palette, the run overlay and the start
 * toast -- and every surface naming a run that already happened reads its
 * phrase from here too: run history, the run summary row and its metadata, and
 * the status strip. "Run draft", "Run v7 · Live" and "Draft · Test" are each
 * written once, so renaming a graph or changing the separator is one edit.
 *
 * A draft run holds no mode: it always goes to test recipients, whatever the
 * workflow's Published mode is, and the target union says so by leaving the
 * field off that arm.
 */

import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";
import type { WorkflowMode } from "#src/lib/workflow-graph-types";

/** Which graph a run starts: the canvas's draft, or the published version. */
export type WorkflowRunGraph = "draft" | "published";

/**
 * What separates a label's two halves. U+00B7 with a space on each side, in one
 * place so every surface spaces it the same way.
 */
const SEPARATOR = " · ";

/** What one press of a Run verb starts, named the way the operator reads it. */
export type WorkflowRunTarget =
  | {
      readonly graph: "draft";
      /** The published version still handling Events, when there is one. */
      readonly publishedVersion?: number;
    }
  | {
      readonly graph: "published";
      readonly publishedVersion: number;
      readonly workflowMode: WorkflowMode;
    };

/** The disabled item standing where a published run would be before the first publish. */
export const NOTHING_PUBLISHED_LABEL = "Nothing published yet";

/** The Published mode's own word, which every label suffixes. */
function modeWord(workflowMode: WorkflowMode): string {
  return workflowMode === "live" ? "Live" : "Test";
}

/**
 * The target a Run verb starts, or `null` when the operator asked for the
 * published version of a workflow that has none.
 */
export function workflowRunTarget(input: {
  graph: WorkflowRunGraph;
  workflowMode: WorkflowMode;
  publishedVersion: number | undefined;
}): WorkflowRunTarget | null {
  if (input.graph === "draft") {
    return input.publishedVersion === undefined
      ? { graph: "draft" }
      : { graph: "draft", publishedVersion: input.publishedVersion };
  }
  if (input.publishedVersion === undefined) {
    return null;
  }
  return {
    graph: "published",
    publishedVersion: input.publishedVersion,
    workflowMode: input.workflowMode,
  };
}

/** The verb itself: "Run draft", or "Run v7 · Live". */
export function runVerbLabel(target: WorkflowRunTarget): string {
  if (target.graph === "draft") {
    return "Run draft";
  }
  return `Run v${target.publishedVersion}${SEPARATOR}${modeWord(target.workflowMode)}`;
}

/**
 * The published run's label wherever it is offered beside "Run draft". Before
 * the first publish it names the reason it is disabled.
 */
export function publishedRunLabel(input: {
  workflowMode: WorkflowMode;
  publishedVersion: number | undefined;
}): string {
  const target = workflowRunTarget({ graph: "published", ...input });
  return target ? runVerbLabel(target) : NOTHING_PUBLISHED_LABEL;
}

/**
 * The Published mode pill: "v7 · Live" once something is published, and the
 * bare word until then, since there is no version for the mode to describe yet.
 */
export function publishedModeLabel(input: {
  workflowMode: WorkflowMode;
  publishedVersion: number | undefined;
}): string {
  const mode = modeWord(input.workflowMode);
  return input.publishedVersion === undefined
    ? mode
    : `v${input.publishedVersion}${SEPARATOR}${mode}`;
}

/**
 * One choice in the Published mode menu: the word, and the sentence saying what
 * that mode does to Events and to manual runs of the published version.
 */
export function publishedModeChoice(input: {
  workflowMode: WorkflowMode;
  publishedVersion: number | undefined;
}): { label: string; description: string } {
  const version =
    input.publishedVersion === undefined
      ? "the published version"
      : `v${input.publishedVersion}`;
  const recipients =
    input.workflowMode === "live"
      ? `Events and manual runs of ${version} send to real recipients.`
      : `Events and manual runs of ${version} go to test recipients. Running the draft never needs this.`;
  // Before the first publish the mode describes a version nobody can run yet,
  // so the sentence says when the setting starts to matter.
  const timing =
    input.publishedVersion === undefined ? " Takes effect on publish." : "";

  return {
    label: modeWord(input.workflowMode),
    description: `${recipients}${timing}`,
  };
}

/** The run overlay's heading, its opening sentence, and its confirm button. */
export function runOverlayCopy(target: WorkflowRunTarget): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  const verb = runVerbLabel(target);

  if (target.graph === "draft") {
    const published =
      target.publishedVersion === undefined
        ? ""
        : ` Published v${target.publishedVersion} keeps handling Events.`;
    return {
      title: verb,
      description: `Runs the draft on this canvas with test recipients.${published}`,
      confirmLabel: verb,
    };
  }

  const recipients =
    target.workflowMode === "live"
      ? `Runs Published v${target.publishedVersion} and sends to real recipients.`
      : `Runs Published v${target.publishedVersion} with test recipients.`;
  return {
    title: verb,
    description: `${recipients} Draft edits are not included.`,
    confirmLabel: verb,
  };
}

/**
 * The facts a run that already started is named by: the graph it pinned, and
 * the recipients it reached. Every read surface passes the run itself.
 */
export type WorkflowRunGraphIdentity = {
  readonly versionKind: WorkflowVersionKind;
  readonly versionNumber: number | null;
  readonly runMode: "live" | "test";
};

/**
 * Which graph a run pinned. "Draft" for a snapshot of the canvas, and the
 * published version by its number: "v7" in a table column, "Published v7" in
 * prose that has room for the word.
 *
 * A published run with no number cannot happen -- the contract refuses one --
 * so the bare word is what the impossible case reads as, on every surface.
 */
export function runGraphLabel(
  run: Pick<WorkflowRunGraphIdentity, "versionKind" | "versionNumber">,
  style: "short" | "qualified" = "short"
): string {
  if (run.versionKind === "draft_snapshot") {
    return "Draft";
  }
  if (run.versionNumber === null) {
    return "Published";
  }
  return style === "qualified"
    ? `Published v${run.versionNumber}`
    : `v${run.versionNumber}`;
}

/** Who a run sent to: "Test" for test recipients, "Live" for real ones. */
export function runRecipientsLabel(runMode: "live" | "test"): string {
  return runMode === "test" ? "Test" : "Live";
}

/**
 * A run in one phrase: "Draft · Test" for a draft run, which always reaches
 * test recipients, or "v7 · Live" / "v7 · Test" for a run of the published
 * graph.
 */
export function runGraphRecipientsLabel(run: WorkflowRunGraphIdentity): string {
  return `${runGraphLabel(run)}${SEPARATOR}${runRecipientsLabel(run.runMode)}`;
}
