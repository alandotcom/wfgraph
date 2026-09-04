import type { EvalNodeSelector } from "#src/agent/types";
import {
  adjacency,
  checkEach,
  hasPath,
  matchesSelector,
  nodeIdsMatching,
  reachableNodeIds,
  selectorName,
  type SemanticsContext,
} from "#src/agent/judges/semantics/context";

function missingFlows(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredFlows, (flow) => {
    const found = context.document.edges.some(
      (edge) =>
        matchesSelector(context.nodeById.get(edge.source), flow.source) &&
        matchesSelector(context.nodeById.get(edge.target), flow.target) &&
        (flow.sourceHandle === undefined ||
          edge.sourceHandle === flow.sourceHandle)
    );
    return found
      ? undefined
      : `missing required flow ${selectorName(flow.source)} -> ${selectorName(flow.target)}${flow.sourceHandle === undefined ? "" : ` through ${flow.sourceHandle}`}`;
  });
}

function missingPaths(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredPaths, (path) =>
    hasPath(context, path)
      ? undefined
      : `missing required path ${selectorName(path.source)} -> ${selectorName(path.target)}`
  );
}

/**
 * A gate must reach its target through the named outlet. A second walk removes
 * those outlet edges and detects another route from a Lifecycle node.
 */
function gateFailures(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredGates, (required) => {
    const gateIds = new Set(nodeIdsMatching(context, required.gate));
    const targetIds = new Set(nodeIdsMatching(context, required.target));
    const gateEdges = context.document.edges.filter(
      (edge) =>
        gateIds.has(edge.source) && edge.sourceHandle === required.sourceHandle
    );
    const gatedReach = reachableNodeIds({
      sourceIds: gateEdges.map((edge) => edge.target),
      targetsBySource: context.targetsBySource,
    });
    const hasGatedPath = [...targetIds].some((nodeId) =>
      gatedReach.has(nodeId)
    );
    if (!hasGatedPath) {
      return `missing required gated path ${selectorName(required.gate)} -> ${selectorName(required.target)} through ${required.sourceHandle}`;
    }

    const acceptedEdgeIds = new Set(gateEdges.map((edge) => edge.id));
    const reachWithoutGate = reachableNodeIds({
      sourceIds: context.lifecycleIds,
      targetsBySource: adjacency({
        edges: context.document.edges.filter(
          (edge) => !acceptedEdgeIds.has(edge.id)
        ),
        nodeById: context.nodeById,
      }),
    });
    return [...targetIds].some((nodeId) => reachWithoutGate.has(nodeId))
      ? `a path to ${selectorName(required.target)} bypasses required gate ${selectorName(required.gate)} through ${required.sourceHandle}`
      : undefined;
  });
}

function nonParallelBranches(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredParallel, (required) =>
    hasPath(context, { source: required.first, target: required.second }) ||
    hasPath(context, { source: required.second, target: required.first })
      ? `${selectorName(required.first)} and ${selectorName(required.second)} are not parallel branches`
      : undefined
  );
}

/** Finds one distinct direct target for every branch in document edge order. */
function findDistinctTargetAssignment(input: {
  candidatesByBranch: readonly (readonly string[])[];
}): string[] | undefined {
  const selectedTargetIds = new Set<string>();
  const assignment: string[] = [];

  function assignBranch(branchIndex: number): string[] | undefined {
    if (branchIndex === input.candidatesByBranch.length) {
      return [...assignment];
    }
    const candidates = input.candidatesByBranch[branchIndex] ?? [];
    for (const targetId of candidates) {
      if (selectedTargetIds.has(targetId)) {
        continue;
      }
      selectedTargetIds.add(targetId);
      assignment.push(targetId);
      const result = assignBranch(branchIndex + 1);
      if (result) {
        return result;
      }
      assignment.pop();
      selectedTargetIds.delete(targetId);
    }
    return undefined;
  }

  return assignBranch(0);
}

function directBranchTargetIds(input: {
  context: SemanticsContext;
  sourceId: string;
  sourceHandle: string;
  target: EvalNodeSelector;
}): string[] {
  const targetIds = new Set<string>();
  for (const edge of input.context.document.edges) {
    if (
      edge.source === input.sourceId &&
      edge.sourceHandle === input.sourceHandle &&
      matchesSelector(input.context.nodeById.get(edge.target), input.target)
    ) {
      targetIds.add(edge.target);
    }
  }
  return [...targetIds];
}

function outletReachableNodeIds(input: {
  context: SemanticsContext;
  sourceId: string;
  sourceHandle: string;
}): Set<string> {
  return reachableNodeIds({
    sourceIds: input.context.document.edges
      .filter(
        (edge) =>
          edge.source === input.sourceId &&
          edge.sourceHandle === input.sourceHandle
      )
      .map((edge) => edge.target),
    targetsBySource: input.context.targetsBySource,
  });
}

function hasDirectTargetCrossRouting(
  candidatesByBranch: readonly (readonly string[])[]
): boolean {
  const outletCountByTarget = new Map<string, number>();
  for (const candidates of candidatesByBranch) {
    for (const targetId of candidates) {
      outletCountByTarget.set(
        targetId,
        (outletCountByTarget.get(targetId) ?? 0) + 1
      );
    }
  }
  return [...outletCountByTarget.values()].some(
    (outletCount) => outletCount > 1
  );
}

function exclusiveBranchFailures(context: SemanticsContext): string[] {
  return checkEach(
    context.input.expected.requiredExclusiveBranches,
    (required) => {
      let hasCrossRoutedDirectTargets = false;
      let hasTargetsThatReachOneAnother = false;
      let hasIndirectCrossRouting = false;
      for (const sourceId of nodeIdsMatching(context, required.source)) {
        const candidatesByBranch = required.branches.map((branch) =>
          directBranchTargetIds({
            context,
            sourceId,
            sourceHandle: branch.sourceHandle,
            target: branch.target,
          })
        );
        if (hasDirectTargetCrossRouting(candidatesByBranch)) {
          hasCrossRoutedDirectTargets = true;
          continue;
        }
        const distinctTargets = findDistinctTargetAssignment({
          candidatesByBranch,
        });
        if (!distinctTargets) {
          continue;
        }
        const reachableTargets = new Map<string, Set<string>>();
        const targetsReach = (
          targetId: string,
          otherTargetId: string
        ): boolean => {
          let reached = reachableTargets.get(targetId);
          if (!reached) {
            reached = reachableNodeIds({
              sourceIds: [targetId],
              targetsBySource: context.targetsBySource,
            });
            reachableTargets.set(targetId, reached);
          }
          return reached.has(otherTargetId);
        };
        const targetsReachOneAnother = distinctTargets.some(
          (targetId, targetIndex) =>
            distinctTargets
              .slice(targetIndex + 1)
              .some(
                (otherTargetId) =>
                  targetsReach(targetId, otherTargetId) ||
                  targetsReach(otherTargetId, targetId)
              )
        );
        if (targetsReachOneAnother) {
          hasTargetsThatReachOneAnother = true;
          continue;
        }
        const reachableByOutlet = required.branches.map((branch) =>
          outletReachableNodeIds({
            context,
            sourceId,
            sourceHandle: branch.sourceHandle,
          })
        );
        const crossRoutesSelectedTarget = distinctTargets.some(
          (targetId, targetIndex) =>
            reachableByOutlet.some(
              (reachableIds, outletIndex) =>
                outletIndex !== targetIndex && reachableIds.has(targetId)
            )
        );
        if (crossRoutesSelectedTarget) {
          hasIndirectCrossRouting = true;
          continue;
        }
        return undefined;
      }
      const sourceName = selectorName(required.source);
      if (hasCrossRoutedDirectTargets) {
        return `${sourceName} exclusive outlets must not share direct targets`;
      }
      if (hasTargetsThatReachOneAnother) {
        return `${sourceName} branch targets must not reach one another`;
      }
      if (hasIndirectCrossRouting) {
        return `${sourceName} exclusive outlets must not reach another outlet's target`;
      }
      return `${sourceName} must route each exclusive branch to a distinct direct target`;
    }
  );
}

/** Runs topology and branching rules in rationale order. */
export function assessTopologyAndBranchingSemantics(
  context: SemanticsContext
): string[] {
  return [
    ...missingFlows(context),
    ...missingPaths(context),
    ...gateFailures(context),
    ...nonParallelBranches(context),
    ...exclusiveBranchFailures(context),
  ];
}
