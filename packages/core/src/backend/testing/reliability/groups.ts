/**
 * Builds the grouped variants of one reliability graph. `withGroupLayout`
 * returns the graph unchanged for `ungrouped`, and otherwise adds one Group
 * frame around `memberIds`. It throws before anything is published when that
 * Group breaks a rule the editor or Publish applies, so a generator that builds
 * an invalid Group fails with the rule's message.
 */

import { groupContractViolations } from "@wfgraph/shared/graph/group-contract";
import { groupStructureRefusalReason } from "@wfgraph/shared/graph/group-structure";
import { analyzeGroupableSelection } from "@wfgraph/shared/graph/node-group";
import type { FixtureGraph } from "#src/backend/testing/reliability/fixtures";
import { node } from "#src/backend/testing/reliability/fixtures";

export const GROUP_LAYOUTS = ["ungrouped", "vertical", "horizontal"] as const;
/** How a variant organizes the steps: no Group, or a Group with a direction. */
export type GroupLayout = (typeof GROUP_LAYOUTS)[number];

export const GROUP_FRAME_ID = "reliability_group";

function graphNodes(graph: FixtureGraph) {
  return graph.nodes.map((item) => item.attributes);
}

function graphEdges(graph: FixtureGraph) {
  return graph.edges.map((item) => item.attributes);
}

/**
 * The refusal the editor or Publish gives the Group `memberIds` would form over
 * `graph`, or null when the Group may be created and published.
 */
function groupRefusal(
  graph: FixtureGraph,
  memberIds: ReadonlySet<string>
): string | null {
  const selection = analyzeGroupableSelection({
    nodes: graphNodes(graph),
    edges: graphEdges(graph),
    selectedIds: memberIds,
  });
  if (!selection.ok)
    return `the editor refuses the selection: ${selection.error}`;
  const grouped = addGroupFrame(graph, memberIds, "vertical");
  const structure = groupStructureRefusalReason({
    nodes: graphNodes(grouped),
    edges: graphEdges(grouped),
  });
  if (structure !== null) return `a draft save refuses it: ${structure}`;
  const violations = groupContractViolations({
    nodes: graphNodes(grouped),
    edges: graphEdges(grouped),
  });
  return violations.length === 0
    ? null
    : `Publish refuses it: ${violations.map((item) => item.message).join("; ")}`;
}

function addGroupFrame(
  graph: FixtureGraph,
  memberIds: ReadonlySet<string>,
  direction: Exclude<GroupLayout, "ungrouped">
): FixtureGraph {
  return {
    nodes: [
      node(GROUP_FRAME_ID, "group", { direction }),
      ...graph.nodes.map((item) =>
        memberIds.has(item.key)
          ? {
              ...item,
              attributes: { ...item.attributes, parentId: GROUP_FRAME_ID },
            }
          : item
      ),
    ],
    edges: graph.edges,
  };
}

/**
 * `graph` organized as `layout`. The stored edges and every step's config are
 * the same in each variant; only the frame and the members' `parentId` differ.
 */
export function withGroupLayout(
  graph: FixtureGraph,
  memberIds: readonly string[],
  layout: GroupLayout
): FixtureGraph {
  if (graph.nodes.some((item) => item.attributes.parentId !== undefined))
    throw new Error("The base graph must have no Group");
  const members = new Set(memberIds);
  const refusal = groupRefusal(graph, members);
  if (refusal !== null)
    throw new Error(
      `Invalid generated Group over ${[...members].join(", ")}: ${refusal}`
    );
  return layout === "ungrouped" ? graph : addGroupFrame(graph, members, layout);
}

/** The ids of the steps the Group frame in `graph` holds, sorted. */
export function groupMemberIds(graph: FixtureGraph): string[] {
  return graph.nodes
    .filter((item) => item.attributes.parentId === GROUP_FRAME_ID)
    .map((item) => item.key)
    .toSorted();
}
