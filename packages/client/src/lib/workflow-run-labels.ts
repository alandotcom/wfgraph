/**
 * Every label a run is named by, before it starts and after it finishes.
 *
 * A draft run has no mode: it is always a test run, so the draft arm of
 * `WorkflowRunTarget` carries no mode field. `runSends` lives here because
 * the run overlay states the sends in the same sentence it confirms.
 */

import { TEST_RUN_SKIP_LABEL } from "#src/lib/test-run-skip";
import {
  type ExtensionCatalog,
  findAction,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { stepTestRunBehavior } from "@wfgraph/shared/actions/test-run-behavior";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { isBlank } from "@wfgraph/shared/types/string";
import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";
import { compact, uniq } from "es-toolkit/array";
import { inactiveBranch } from "#src/lib/inactive-branch";
import type {
  WorkflowEdge,
  WorkflowMode,
  WorkflowNode,
} from "#src/lib/workflow-graph-types";

/** Which graph a run starts: the canvas's draft, or the published version. */
export type WorkflowRunGraph = "draft" | "published";

/**
 * What separates a label's two halves. U+00B7 with a space on each side, in one
 * place so every surface spaces it the same way.
 */
const SEPARATOR = " · ";

/** What one run command starts. */
export type WorkflowRunTarget =
  | {
      readonly graph: "draft";
    }
  | {
      readonly graph: "published";
      readonly publishedVersion: number;
      readonly workflowMode: WorkflowMode;
    };

/** The disabled item standing where a published run would be before the first publish. */
export const NOTHING_PUBLISHED_LABEL = "Nothing published yet";

/** The word for a Published mode, used as a label suffix and on its own. */
export function publishedModeWord(workflowMode: WorkflowMode): string {
  return workflowMode === "live" ? "Live" : "Test";
}

/**
 * The one state a workflow is in, as the Workflows list and the editor's
 * publication chip both state it. A paused workflow starts no run, and one
 * with no published version has nothing an Event can start, so neither has a
 * Published mode to state. Otherwise the state is the Published mode.
 */
export type WorkflowPublicationState =
  | "paused"
  | "never_published"
  | "live"
  | "test";

export function workflowPublicationState(input: {
  isPaused: boolean;
  isPublished: boolean;
  workflowMode: WorkflowMode;
}): WorkflowPublicationState {
  if (input.isPaused) {
    return "paused";
  }
  if (!input.isPublished) {
    return "never_published";
  }
  return input.workflowMode;
}

export const WORKFLOW_PUBLICATION_STATE_LABELS: Record<
  WorkflowPublicationState,
  string
> = {
  paused: "Paused",
  never_published: "Never published",
  live: publishedModeWord("live"),
  test: publishedModeWord("test"),
};

/**
 * The editor's publication chip: the state in the list's words, then the
 * published version and whether the draft holds changes it does not, as
 * "Live · v2 · changes not published", "Test · v3", "Never published", or
 * with the same parts after "Paused" once paused: "Paused · Live · v2".
 */
export function publicationChipLabel(input: {
  isPaused: boolean;
  isPublished: boolean;
  workflowMode: WorkflowMode;
  publishedVersion: number | undefined;
  hasUnpublishedChanges: boolean;
}): string {
  if (!input.isPublished) {
    return input.isPaused
      ? WORKFLOW_PUBLICATION_STATE_LABELS.paused
      : WORKFLOW_PUBLICATION_STATE_LABELS.never_published;
  }
  // A paused workflow keeps the facts the pause holds back.
  return compact([
    input.isPaused ? WORKFLOW_PUBLICATION_STATE_LABELS.paused : null,
    publishedModeWord(input.workflowMode),
    input.publishedVersion === undefined ? null : `v${input.publishedVersion}`,
    input.hasUnpublishedChanges ? "changes not published" : null,
  ]).join(" · ");
}

/**
 * The target a run command starts. Returns `null` when the command asks for the
 * published version of a workflow that has never been published.
 */
export function workflowRunTarget(input: {
  graph: WorkflowRunGraph;
  workflowMode: WorkflowMode;
  publishedVersion: number | undefined;
}): WorkflowRunTarget | null {
  if (input.graph === "draft") {
    // The draft says nothing about the published version: it runs the canvas
    // as a test run, whether or not anything has ever been published.
    return { graph: "draft" };
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

/** The command label: "Run draft", or "Run v7 · Live". */
export function runCommandLabel(target: WorkflowRunTarget): string {
  if (target.graph === "draft") {
    return "Run draft";
  }
  return `Run v${target.publishedVersion}${SEPARATOR}${publishedModeWord(target.workflowMode)}`;
}

/**
 * The label for the published run command, which is offered beside "Run draft".
 * Before the first publish it names why the command is disabled.
 */
export function publishedRunLabel(input: {
  workflowMode: WorkflowMode;
  publishedVersion: number | undefined;
}): string {
  const target = workflowRunTarget({ graph: "published", ...input });
  return target ? runCommandLabel(target) : NOTHING_PUBLISHED_LABEL;
}

/**
 * One choice in the Published mode menu: the mode's word, and one sentence on
 * what the mode does.
 */
export function publishedModeChoice(workflowMode: WorkflowMode): {
  label: string;
  description: string;
} {
  return {
    label: publishedModeWord(workflowMode),
    // What the mode does, from CONTEXT.md's Published mode: Events start
    // runs either way, and only the recipients differ.
    description:
      workflowMode === "live"
        ? "Real Events start runs, and every step reaches real recipients."
        : "Real Events still start runs, and each step follows its In test runs setting.",
  };
}

/** Who a run of a published version in `workflowMode` reaches, as a phrase. */
export function publishedModeRecipients(workflowMode: WorkflowMode): string {
  return workflowMode === "live" ? "Real recipients" : "Test recipients";
}

/**
 * What Pause and Resume do, from CONTEXT.md's Paused workflow: a pause
 * refuses every new start and leaves the runs in progress alone.
 */
export const PAUSE_EFFECT =
  "New Events, schedules and manual runs start nothing. Runs in progress continue.";
export const RESUME_EFFECT =
  "Events, schedules and manual runs start runs again.";

/**
 * The steps of a graph that change something outside the workflow through an
 * integration, and which integrations carry them. Counted from the graph the
 * run executes, so a published run counts the published version's nodes rather
 * than the current canvas.
 */
export type RunSends = {
  readonly count: number;
  /** Display names, in the order the graph's nodes first reach each one. */
  readonly integrations: readonly string[];
};

/**
 * Counts the steps of a graph that send outward. A step counts when its catalog
 * action sets `sideEffect`, so a lookup is skipped.
 *
 * Disabled steps and everything stranded behind them are skipped as well, using
 * the same reachability rule the canvas draws with (`inactiveBranch`).
 */
export function runSends(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): RunSends {
  const { nodeIds: stranded } = inactiveBranch({
    nodes: input.nodes,
    edges: input.edges,
  });

  const integrationTypes = compact(
    input.nodes.map((node) => {
      if (node.data.enabled === false || stranded.has(node.id)) {
        return undefined;
      }
      const actionType = actionTypeOf(node);
      const action = actionType
        ? findAction(input.catalog, actionType)
        : undefined;
      return action?.sideEffect === true ? action.integration : undefined;
    })
  );

  return {
    count: integrationTypes.length,
    integrations: uniq(integrationTypes).map(
      (type) => findIntegration(input.catalog, type)?.label ?? type
    ),
  };
}

/**
 * Renders the sends as a phrase: "2 steps reach outside this workflow: Linear,
 * Clerk". A counted step is any step with a side effect, which covers filing a
 * ticket and deleting a user as well as sending a message, so the phrase names
 * the count and the integrations rather than a medium or a recipient. The run
 * dialog hides the line when the count is 0, so the zero phrase is a fallback
 * for a caller that renders it anyway.
 */
export function runSendsLabel(sends: RunSends): string {
  if (sends.count === 0) {
    return "No steps reach outside this workflow";
  }
  const counted =
    sends.count === 1
      ? "1 step reaches outside this workflow"
      : `${sends.count} steps reach outside this workflow`;
  return sends.integrations.length === 0
    ? counted
    : `${counted}: ${sends.integrations.join(", ")}`;
}

/** Up to three names, then how many more: "A, B and C", "A, B, C and 2 more". */
function namesPhrase(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const head = more > 0 ? shown : shown.slice(0, -1);
  const last = more > 0 ? `${more} more` : shown.at(-1);
  return head.length === 0 ? (last ?? "") : `${head.join(", ")} and ${last}`;
}

/**
 * What a test run of this graph does at the steps that reach outside it, in
 * sentences naming those steps, from the rule `stepTestRunBehavior` states:
 * "Send reminder and Alert the desk are skipped in this draft run.", "Text the
 * patient sends to Test Phone Number "+15557654321".", and for the steps whose
 * app decides, which ones they are and where the run says what they did. A step is counted when
 * a run can reach it, by the reachability `runSends` uses. Built-in steps reach
 * nothing outside, and an action with no "In test runs" setting counts only
 * when its catalog entry sets `sideEffect`. `run` names the run in the
 * sentences.
 */
export function testRunStepsSentence(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
  run: "draft run" | "test run";
}): string {
  const { nodeIds: stranded } = inactiveBranch({
    nodes: input.nodes,
    edges: input.edges,
  });
  const steps = input.nodes.flatMap((node) => {
    if (node.data.enabled === false || stranded.has(node.id)) {
      return [];
    }
    const behavior = stepTestRunBehavior(node, input.catalog);
    const actionId = actionTypeOf(node);
    const action = actionId ? findAction(input.catalog, actionId) : undefined;
    if (
      behavior === undefined ||
      behavior.kind === "built-in" ||
      (behavior.kind === "handler-decides" && action?.sideEffect !== true)
    ) {
      return [];
    }
    const name = isBlank(node.data.label)
      ? (action?.label ?? "A step")
      : node.data.label;
    return [{ name, behavior }];
  });
  if (steps.length === 0) {
    return "No step reaches outside this workflow.";
  }
  const skipped = steps.flatMap((step) =>
    step.behavior.kind === "setting" && step.behavior.skips ? [step.name] : []
  );
  const appDecides = steps.flatMap((step) =>
    step.behavior.kind === "handler-decides" ? [step.name] : []
  );
  const followed = steps.flatMap((step) => {
    const { behavior } = step;
    if (behavior.kind !== "setting" || behavior.skips) {
      return [];
    }
    const empty = behavior.shownFields.find((field) => field.value === null);
    if (empty) {
      return [
        `${step.name} is set to ${behavior.optionLabel}, but ${empty.label} is empty, so it does nothing.`,
      ];
    }
    const target = behavior.shownFields[0];
    return [
      target
        ? `${step.name} sends to ${target.label} ${target.value}.`
        : `${step.name}: ${behavior.optionLabel}.`,
    ];
  });
  return compact([
    skipped.length > 0
      ? `${namesPhrase(skipped)} ${skipped.length === 1 ? "is" : "are"} skipped in this ${input.run}.`
      : null,
    ...followed,
    // An action with no "In test runs" setting decides in its own handler,
    // and nothing in the catalog says what it decides, so the sentence names
    // those steps and says where the answer shows once the run has happened.
    appDecides.length > 0
      ? `Whether ${namesPhrase(appDecides)} ${appDecides.length === 1 ? "does" : "do"} anything is up to the app; afterwards the run shows "${TEST_RUN_SKIP_LABEL}" on a step that did nothing.`
      : null,
  ]).join(" ");
}

/**
 * The run dialog's heading, opening sentence, and confirm button.
 *
 * The heading and the button both repeat the command that opened the dialog.
 * The description says what the run does with each step that reaches outside
 * the workflow, `testRunSteps` from `testRunStepsSentence`, so the button never
 * has to carry it.
 */
export function runOverlayCopy(
  target: WorkflowRunTarget,
  testRunSteps: string
): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (target.graph === "draft") {
    return {
      title: "Run draft",
      // Continue now is offered on a draft run alone, so only this sentence
      // names it.
      description: `Runs the draft as a test run. ${testRunSteps} A Wait waits its full time unless you press Continue now.`,
      confirmLabel: "Run draft",
    };
  }

  // "Run v5" rather than the full command label: the dialog confirms one
  // version, and its description already says what that mode does.
  const command = `Run v${target.publishedVersion}`;
  return {
    title: command,
    description:
      target.workflowMode === "live"
        ? `Runs v${target.publishedVersion} and sends to real recipients.`
        : `Runs v${target.publishedVersion} as a test run. ${testRunSteps}`,
    confirmLabel: command,
  };
}

/**
 * The fields a started run is named by: the graph it pinned and the recipients
 * it reached. Read surfaces pass the run record itself.
 */
export type WorkflowRunGraphIdentity = {
  readonly versionKind: WorkflowVersionKind;
  readonly versionNumber: number | null;
  readonly runMode: "live" | "test";
};

/**
 * Names the graph a run pinned: "Draft" for a canvas snapshot, "v7" for a
 * published version.
 *
 * The contract rejects a published run without a version number, so the bare
 * "Published" is only a fallback for a row that should not exist.
 */
export function runGraphLabel(
  run: Pick<WorkflowRunGraphIdentity, "versionKind" | "versionNumber">
): string {
  if (run.versionKind === "draft_snapshot") {
    return "Draft";
  }
  if (run.versionNumber === null) {
    return "Published";
  }
  return `v${run.versionNumber}`;
}

/** Who a run sent to: "Test" for test recipients, "Live" for real ones. */
export function runRecipientsLabel(runMode: "live" | "test"): string {
  return runMode === "test" ? "Test" : "Live";
}

/**
 * Names a run in one phrase. A draft run reads "Draft · Test", because it always
 * reaches test recipients. A published run reads "v7 · Live" or "v7 · Test".
 */
export function runGraphRecipientsLabel(run: WorkflowRunGraphIdentity): string {
  return `${runGraphLabel(run)}${SEPARATOR}${runRecipientsLabel(run.runMode)}`;
}

/**
 * How many characters from the end of a run's id identify it on screen.
 *
 * A run id is a 36-character UUIDv7. Its leading characters hold the
 * millisecond it was minted in and repeat across every run started around the
 * same time, so the last eight characters are the ones that tell two runs of
 * one workflow apart.
 */
const RUN_ID_SUFFIX_LENGTH = 8;

/**
 * The identifier a developer quotes for a run: the Run row of the run's
 * summary and the status strip print it. It is cut from the run's own id, so
 * it never changes with the rows a list shows, and the full id in the URL ends
 * with it.
 */
export function runShortId(executionId: string): string {
  return executionId.slice(-RUN_ID_SUFFIX_LENGTH);
}
