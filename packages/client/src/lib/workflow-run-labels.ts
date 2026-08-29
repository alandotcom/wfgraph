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
 *
 * `runSends` sits here too, because the sends a live run is confirmed against
 * are a fact of the graph read straight into the sentence stating them.
 */

import {
  type ExtensionCatalog,
  findAction,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowVersionKind } from "@wfgraph/shared/graph/version-kinds";
import { compact, uniq } from "es-toolkit";
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

/** What one press of a Run verb starts, named the way the operator reads it. */
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

/**
 * The Published mode's own word, which every label suffixes and which the
 * strip's mode control wears on its own.
 */
export function publishedModeWord(workflowMode: WorkflowMode): string {
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
    // The draft says nothing about the published version: it runs the canvas,
    // with test recipients, whether or not anything has ever been published.
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

/** The verb itself: "Run draft", or "Run v7 · Live". */
export function runVerbLabel(target: WorkflowRunTarget): string {
  if (target.graph === "draft") {
    return "Run draft";
  }
  return `Run v${target.publishedVersion}${SEPARATOR}${publishedModeWord(target.workflowMode)}`;
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
 * One choice in the Published mode menu: the word, and who that mode sends to.
 *
 * A clause rather than a sentence, because the control sits beside the
 * publication badge that already names the version, and the menu's own title
 * says the setting is about the published version.
 */
export function publishedModeChoice(workflowMode: WorkflowMode): {
  label: string;
  description: string;
} {
  return {
    label: publishedModeWord(workflowMode),
    description:
      workflowMode === "live" ? "Real recipients" : "Test recipients",
  };
}

/**
 * What a run of a given graph can send outward: the steps that change something
 * outside the workflow through an integration, and which integrations those are.
 *
 * Counted off the graph the run will execute, so a published run counts the
 * published version's nodes rather than whatever the canvas holds now.
 */
export type RunSends = {
  readonly count: number;
  /** Display names, in the order the graph's nodes first reach each one. */
  readonly integrations: readonly string[];
};

/**
 * The steps of a graph that reach outside it: an action that changes something
 * outside the workflow, carried by an integration. A lookup is not one of them,
 * which is what `sideEffect` on the catalog's action answers.
 *
 * A step the run will not perform is left out along with everything stranded
 * behind it, so a graph whose only send hangs off a switched-off step counts
 * nothing. `inactiveBranch` owns that reachability rule for the canvas already.
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
 * The sends stated as a fact: "3 sends: Slack, Resend". This is what a live
 * published run is confirmed against, so it names no recipient, only how many
 * outward steps the graph holds and which integrations carry them.
 */
export function runSendsLabel(sends: RunSends): string {
  if (sends.count === 0) {
    return "No sends";
  }
  const counted = sends.count === 1 ? "1 send" : `${sends.count} sends`;
  return sends.integrations.length === 0
    ? counted
    : `${counted}: ${sends.integrations.join(", ")}`;
}

/**
 * The run overlay's heading, its opening sentence, and its confirm button.
 *
 * The published heading names the version in prose ("Run Published v7") while
 * its confirm button keeps the verb the operator pressed, except live-ward,
 * where the button names the consequence instead of the version.
 */
export function runOverlayCopy(target: WorkflowRunTarget): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (target.graph === "draft") {
    const verb = runVerbLabel(target);
    return {
      title: verb,
      description: "Runs the draft on this canvas with test recipients.",
      confirmLabel: verb,
    };
  }

  const title = `Run Published v${target.publishedVersion}`;
  if (target.workflowMode === "live") {
    return {
      title,
      description: `Runs Published v${target.publishedVersion} and sends to real recipients.`,
      confirmLabel: "Send to real recipients",
    };
  }
  return {
    title,
    description: `Runs Published v${target.publishedVersion} with test recipients.`,
    confirmLabel: runVerbLabel(target),
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
