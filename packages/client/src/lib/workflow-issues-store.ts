/**
 * What is wrong with the graph on screen, kept current as it is edited.
 *
 * One pass over the whole graph feeds both surfaces that report it: the badge on
 * each broken node and the count in the toolbar. Validating per node render
 * instead would run the same walk once per card and give the two surfaces no way
 * to agree.
 *
 * The collector itself is `@wfgraph/shared/graph/workflow-issues`, shared with
 * the pre-run check and the server's own vocabulary for the same failures.
 */

import { groupBy } from "es-toolkit";
import { atom } from "jotai";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  collectWorkflowIssues,
  hasBlockingWorkflowIssues,
  type WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { NodeIssueSummary } from "#src/lib/workflow-graph-types";

/**
 * The one array standing for "nothing to say", so a pass that finds nothing and
 * a load that clears the list both write the value already there. jotai skips a
 * write it compares equal, which spares the Map below a rebuild.
 */
export const NO_ISSUES: WorkflowIssue[] = [];

/**
 * Written by `useCollectWorkflowIssues`, the only thing that may say what is
 * wrong. `loadWorkflowGraphAtom` empties it, because the graph those issues
 * describe has just been replaced.
 */
export const workflowIssuesAtom = atom<WorkflowIssue[]>(NO_ISSUES);

/**
 * The half of the list the shared collector cannot produce, kept so the issues
 * dialog can recollect without asking every connection again.
 *
 * `useCollectWorkflowIssues` owns the write, the same way it owns the list
 * above, and both are empty until the answers that justify them arrive.
 */
export const providerFieldIssuesAtom = atom<WorkflowIssue[]>(NO_ISSUES);

/**
 * Everything wrong with a graph: what the shared collector can see on its own,
 * followed by what only the operator's connections can answer.
 *
 * The two halves are assembled here rather than at each place that needs them.
 * The badge on a node, the count in the status strip, the run gate and the
 * publish gate each read this list, and they were each appending the provider
 * half themselves, so "the gate and the canvas cannot disagree" was a sentence
 * repeated in three comments rather than a fact about the code. It is one call
 * now, and disagreeing would take an edit here.
 *
 * `providerIssues` is passed rather than read off the atom, because the pass
 * that writes that atom is also a caller and must use the answers it just
 * received rather than the ones it is about to store. `nodes` arrives already
 * through `toPersistedNodes`, which is the same shape the provider half is asked
 * about, so both halves judge one graph.
 */
export function collectAllWorkflowIssues(input: {
  nodes: WorkflowNode[];
  catalog: ExtensionCatalog;
  integrations: ReadonlyArray<{ id: string; type: string }>;
  providerIssues: readonly WorkflowIssue[];
}): WorkflowIssue[] {
  return [
    ...collectWorkflowIssues({
      nodes: input.nodes,
      catalog: input.catalog,
      integrations: input.integrations,
    }),
    ...input.providerIssues,
  ];
}

/**
 * The badge each flagged node draws, built once per collection pass.
 *
 * Summarised here rather than where the node is painted, because a summary
 * rebuilt inside `displayNodesAtom` would be a new object on every recompute --
 * that is, on every frame of every drag -- and a node whose `data` is new cannot
 * bail out of rendering. Built here it changes only when the issues do.
 */
export const workflowIssuesByNodeIdAtom = atom((get) => {
  const byNode = groupBy(get(workflowIssuesAtom), (issue) => issue.nodeId);

  const next = new Map(
    Object.entries(byNode).map(([nodeId, forNode]) => {
      // Reuse the last summary for a node whose own issues have not changed.
      // The list changes whenever any node does, so without this, filling in
      // one field would hand every other flagged node a new summary, miss the
      // paint cache for all of them, and re-render the lot.
      const summary = summarizeNodeIssues(forNode);
      const previous = lastSummaries.get(nodeId);
      return [
        nodeId,
        previous && sameSummary(previous, summary) ? previous : summary,
      ];
    })
  );

  lastSummaries = next;
  return next;
});

/** The summaries handed out last time, so unchanged nodes keep their identity. */
let lastSummaries: ReadonlyMap<string, NodeIssueSummary> = new Map();

function sameSummary(left: NodeIssueSummary, right: NodeIssueSummary): boolean {
  return (
    left.severity === right.severity &&
    left.messages.length === right.messages.length &&
    left.messages.every((message, index) => message === right.messages[index])
  );
}

/** Whether anything in the graph stops it being published. */
export const hasBlockingWorkflowIssuesAtom = atom((get) =>
  hasBlockingWorkflowIssues(get(workflowIssuesAtom))
);

/** Stands in for "no issues" so a run overlay allocates no map. */
export const EMPTY_ISSUES: ReadonlyMap<string, NodeIssueSummary> = new Map();

/**
 * One node's issues, as the face its card draws. A node carrying anything
 * blocking is blocking, however many warnings sit beside it.
 */
export function summarizeNodeIssues(
  issues: readonly WorkflowIssue[]
): NodeIssueSummary {
  return {
    severity: issues.some((issue) => issue.severity === "blocking")
      ? "blocking"
      : "warning",
    messages: issues.map((issue) => issue.message),
  };
}

/**
 * Whether two collection passes said the same thing.
 *
 * The collector answers with a fresh array every time, so identity cannot tell
 * a changed verdict from a repeated one. Kind, node and message are the whole
 * of what reaches a reader: severity travels with kind, and the field an issue
 * names is already inside its message.
 */
export function sameIssues(
  left: readonly WorkflowIssue[],
  right: readonly WorkflowIssue[]
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }

  return left.every((issue, index) => {
    const other = right[index];
    return (
      issue.kind === other.kind &&
      issue.nodeId === other.nodeId &&
      issue.message === other.message
    );
  });
}
