/**
 * Every label a run is named by, before it starts and after it finishes.
 *
 * A draft run has no mode: it always reaches test recipients, so the draft arm
 * of `WorkflowRunTarget` carries no mode field. `runSends` lives here because
 * the run overlay states the sends in the same sentence it confirms.
 */

import {
  type ExtensionCatalog,
  findAction,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
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
 * The target a run command starts. Returns `null` when the command asks for the
 * published version of a workflow that has never been published.
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
 * One choice in the Published mode menu: the mode's word, and who that mode
 * sends to. The description is a clause, because the menu title and the
 * publication badge beside it already supply the rest.
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

/**
 * The run dialog's heading, opening sentence, and confirm button.
 *
 * The heading and the button both repeat the command that opened the dialog.
 * The sentence is where the recipients are named, so the button never has to
 * carry them.
 */
export function runOverlayCopy(target: WorkflowRunTarget): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (target.graph === "draft") {
    return {
      title: "Run draft",
      description: "Runs the draft and sends to test recipients.",
      confirmLabel: "Run draft",
    };
  }

  // "Run v5" rather than the full command label: the dialog confirms one
  // version, and its sentence already says which recipients that mode reaches.
  const command = `Run v${target.publishedVersion}`;
  return {
    title: command,
    description:
      target.workflowMode === "live"
        ? `Runs v${target.publishedVersion} and sends to real recipients.`
        : `Runs v${target.publishedVersion} and sends to test recipients.`,
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
 * Names the graph a run pinned. A canvas snapshot reads "Draft"; a published
 * version reads "v7" in a table column and "Published v7" in prose.
 *
 * The contract rejects a published run without a version number, so the bare
 * "Published" is only a fallback for a row that should not exist.
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
 * Names a run in one phrase. A draft run reads "Draft · Test", because it always
 * reaches test recipients. A published run reads "v7 · Live" or "v7 · Test".
 */
export function runGraphRecipientsLabel(run: WorkflowRunGraphIdentity): string {
  return `${runGraphLabel(run)}${SEPARATOR}${runRecipientsLabel(run.runMode)}`;
}
