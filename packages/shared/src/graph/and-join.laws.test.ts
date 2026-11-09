/**
 * The laws `and-join.ts` states in its header, checked against generated
 * workflow graphs. A generated graph is acyclic, as a saved graph is, starts
 * at a Lifecycle Node, and mixes steps, Conditions, Waits and Event Splits
 * whose edges leave by any of their outlets, so joins of every legality occur.
 * Several laws extend a generated graph with fresh nodes and say how the
 * verdict may change.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { andJoinArms, andJoinRefusalReason } from "#src/graph/and-join";
import {
  NODE_IDS,
  workflowNode,
  type NodeKind,
} from "#src/graph/graph-arbitraries-test-support";
import {
  isConditionNode,
  isEventSplitActionNode,
  isWaitNode,
} from "#src/graph/node-config";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { upstreamNodeIds } from "#src/graph/upstream-nodes";
import { eventSplitOutlet } from "#src/lifecycle/event-split";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";

type Graph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

/** The kinds a generated node after the Lifecycle Node takes. */
type StepKind = Extract<NodeKind, "step" | "condition" | "wait" | "eventSplit">;

const stepKindArbitrary: fc.Arbitrary<StepKind> = fc.oneof(
  { arbitrary: fc.constant("step" as const), weight: 3 },
  {
    arbitrary: fc.constantFrom(
      "condition" as const,
      "wait" as const,
      "eventSplit" as const
    ),
    weight: 2,
  }
);

/**
 * The handle an edge leaving `node` by its first or second outlet carries. A
 * step and a Wait have one outlet and name no handle.
 */
function outlet(node: WorkflowNode, second: boolean): string | undefined {
  if (node.data.type === "lifecycle") {
    return second ? LIFECYCLE_CANCELED_HANDLE : LIFECYCLE_STARTED_HANDLE;
  }
  if (isConditionNode(node)) {
    return second ? "false" : "true";
  }
  if (isEventSplitActionNode(node)) {
    return eventSplitOutlet(second ? "app/b" : "app/a");
  }
  return undefined;
}

function edge(input: {
  source: WorkflowNode;
  target: string;
  second?: boolean | undefined;
}): WorkflowEdge {
  const sourceHandle = outlet(input.source, input.second ?? false);
  return {
    id: `${input.source.id}-${sourceHandle ?? "out"}-${input.target}`,
    source: input.source.id,
    target: input.target,
    sourceHandle,
  };
}

/** Which outlet a generated edge leaves by, usually the first. */
const secondOutlet = fc.oneof(
  { arbitrary: fc.constant(false), weight: 3 },
  { arbitrary: fc.constant(true), weight: 1 }
);

/**
 * An acyclic graph. Its first node is the Lifecycle Node when `entry` is set
 * and a step otherwise. Most later nodes have an edge from some earlier node,
 * so most are reachable, and further edges run from an earlier node to a later
 * one, by either outlet of the source. Two edges may join the same pair.
 */
function graphArbitrary(options: { entry: boolean }): fc.Arbitrary<Graph> {
  return fc
    .integer({ min: 1, max: NODE_IDS.length - 1 })
    .chain((count) =>
      fc.record({
        ids: fc.shuffledSubarray([...NODE_IDS], {
          minLength: count + 1,
          maxLength: count + 1,
        }),
        kinds: fc.array(stepKindArbitrary, {
          minLength: count,
          maxLength: count,
        }),
        // One entry per node after the first: the earlier node its edge comes
        // from, picked by index, or nothing for a node left unreachable.
        parents: fc.array(
          fc.option(fc.record({ pick: fc.nat(), second: secondOutlet }), {
            freq: 6,
            nil: undefined,
          }),
          { minLength: count, maxLength: count }
        ),
        links: fc.array(
          fc.record({
            from: fc.nat(count),
            to: fc.nat(count),
            second: secondOutlet,
          }),
          { maxLength: 6 }
        ),
      })
    )
    .map(({ ids, kinds, parents, links }) => {
      const nodes = ids.map((id, index) =>
        workflowNode({
          id,
          kind:
            index === 0
              ? options.entry
                ? "lifecycle"
                : "step"
              : (kinds[index - 1] ?? "step"),
        })
      );
      const pairs = [
        ...parents.flatMap((parent, index) =>
          parent === undefined
            ? []
            : [{ from: parent.pick % (index + 1), to: index + 1, ...parent }]
        ),
        ...links,
      ];
      const edges = pairs.flatMap(({ from, to, second }) => {
        const source = nodes[Math.min(from, to)];
        const target = nodes[Math.max(from, to)];
        return from === to || !source || !target
          ? []
          : [edge({ source, target: target.id, second })];
      });
      return { nodes, edges };
    });
}

const workflowArbitrary = graphArbitrary({ entry: true });

/** Whether a run can reach `nodeId`: it is the Lifecycle Node or lies behind it. */
function reachesEntry(graph: Graph, nodeId: string): boolean {
  const lifecycleIds = graph.nodes
    .filter((node) => node.data.type === "lifecycle")
    .map((node) => node.id);
  const upstream = upstreamNodeIds(nodeId, graph.edges);
  return lifecycleIds.some((id) => id === nodeId || upstream.has(id));
}

/** The Lifecycle Node of a generated workflow, which is always its first node. */
function entryNode(graph: Graph): WorkflowNode {
  const [first] = graph.nodes;
  if (first?.data.type !== "lifecycle") {
    throw new Error("A generated workflow starts at its Lifecycle Node");
  }
  return first;
}

/** A generated workflow and one of its nodes a run can reach. */
const workflowWithReachableNode = workflowArbitrary.chain((graph) =>
  fc.record({
    graph: fc.constant(graph),
    from: fc.constantFrom(
      ...graph.nodes.filter((node) => reachesEntry(graph, node.id))
    ),
  })
);

/** How long a fresh arm is, in steps. */
const armLength = fc.integer({ min: 1, max: 3 });

/**
 * A chain of fresh steps named `prefix-0`, `prefix-1` and so on, the step at
 * `waitAt` a Wait when it is given.
 */
function arm(input: {
  prefix: string;
  length: number;
  waitAt?: number | undefined;
}): WorkflowNode[] {
  return Array.from({ length: input.length }, (_, index) =>
    workflowNode({
      id: `${input.prefix}-${index}`,
      kind: index === input.waitAt ? "wait" : "step",
    })
  );
}

/** Edges from `source` through each node of `nodes` in turn, and on to `target`. */
function chain(input: {
  source: WorkflowNode;
  second?: boolean | undefined;
  nodes: readonly WorkflowNode[];
  target: string;
}): WorkflowEdge[] {
  const stops = [input.source, ...input.nodes];
  return stops.map((stop, index) =>
    edge({
      source: stop,
      target: input.nodes[index]?.id ?? input.target,
      second: index === 0 ? input.second : false,
    })
  );
}

const JOIN_ID = "new-join";

/** One fresh arm into the join: the steps it runs through after `source`. */
type Arm = {
  source: WorkflowNode;
  /** Whether the arm leaves `source` by its second outlet. */
  second?: boolean | undefined;
  nodes: WorkflowNode[];
};

/**
 * `graph` with fresh arms that meet at a fresh join, plus `extraNodes` and
 * `extraEdges` an arm's source needs.
 */
function withJoin(input: {
  graph: Graph;
  extraNodes?: readonly WorkflowNode[] | undefined;
  extraEdges?: readonly WorkflowEdge[] | undefined;
  arms: readonly Arm[];
}): Graph {
  const join = workflowNode({ id: JOIN_ID, kind: "step" });
  return {
    nodes: [
      ...input.graph.nodes,
      ...(input.extraNodes ?? []),
      ...input.arms.flatMap((item) => item.nodes),
      join,
    ],
    edges: [
      ...input.graph.edges,
      ...(input.extraEdges ?? []),
      ...input.arms.flatMap((item) => chain({ ...item, target: JOIN_ID })),
    ],
  };
}

/** The ids of nodes with more than one incoming edge, in node order. */
function multiIncomingIds(graph: Graph): string[] {
  const incoming = Map.groupBy(graph.edges, (item) => item.target);
  return graph.nodes
    .filter((node) => (incoming.get(node.id)?.length ?? 0) > 1)
    .map((node) => node.id);
}

describe("andJoinRefusalReason laws", () => {
  it("finds a join at exactly each node with more than one incoming edge, and refuses nothing without one", () => {
    fc.assert(
      fc.property(workflowArbitrary, (graph) => {
        const joinIds = andJoinArms(graph).map((join) => join.joinNodeId);

        expect(joinIds).toEqual(multiIncomingIds(graph));
        if (joinIds.length === 0) {
          expect(andJoinRefusalReason(graph)).toBeNull();
        }
      })
    );
  });

  it("refuses a graph in any node or edge order exactly when it refuses it in one", () => {
    const inputArbitrary = workflowArbitrary.chain((graph) =>
      fc.record({
        graph: fc.constant(graph),
        reordered: fc.record({
          nodes: fc.shuffledSubarray(graph.nodes, {
            minLength: graph.nodes.length,
          }),
          edges: fc.shuffledSubarray(graph.edges, {
            minLength: graph.edges.length,
          }),
        }),
      })
    );
    fc.assert(
      fc.property(inputArbitrary, ({ graph, reordered }) => {
        expect(andJoinRefusalReason(reordered) === null).toBe(
          andJoinRefusalReason(graph) === null
        );
      })
    );
  });

  it("answers the same when any steps are disabled", () => {
    const inputArbitrary = workflowArbitrary.chain((graph) =>
      fc.record({
        graph: fc.constant(graph),
        disabled: fc.subarray(graph.nodes.map((node) => node.id)),
      })
    );
    fc.assert(
      fc.property(inputArbitrary, ({ graph, disabled }) => {
        const nodes = graph.nodes.map((node) =>
          disabled.includes(node.id)
            ? { ...node, data: { ...node.data, enabled: false } }
            : node
        );

        expect(andJoinRefusalReason({ ...graph, nodes })).toBe(
          andJoinRefusalReason(graph)
        );
      })
    );
  });

  it("answers a graph beside a disconnected fragment with the graph's refusal, or else the fragment's", () => {
    const prefixed = (graph: Graph, prefix: string): Graph => ({
      nodes: graph.nodes.map((node) => ({
        ...node,
        id: `${prefix}${node.id}`,
      })),
      edges: graph.edges.map((item) => ({
        ...item,
        source: `${prefix}${item.source}`,
        target: `${prefix}${item.target}`,
      })),
    });
    fc.assert(
      fc.property(
        workflowArbitrary,
        graphArbitrary({ entry: false }),
        (workflow, fragment) => {
          const graph = prefixed(workflow, "graph:");
          const detached = prefixed(fragment, "fragment:");

          expect(
            andJoinRefusalReason({
              nodes: [...graph.nodes, ...detached.nodes],
              edges: [...graph.edges, ...detached.edges],
            })
          ).toBe(andJoinRefusalReason(graph) ?? andJoinRefusalReason(detached));
        }
      )
    );
  });

  it("answers the same after a fresh step is added behind any node by one edge", () => {
    const inputArbitrary = workflowArbitrary.chain((graph) =>
      fc.record({
        graph: fc.constant(graph),
        from: fc.constantFrom(...graph.nodes),
        second: fc.boolean(),
      })
    );
    fc.assert(
      fc.property(inputArbitrary, ({ graph, from, second }) => {
        const leaf = workflowNode({ id: "new-leaf", kind: "step" });

        expect(
          andJoinRefusalReason({
            nodes: [...graph.nodes, leaf],
            edges: [
              ...graph.edges,
              edge({ source: from, target: leaf.id, second }),
            ],
          })
        ).toBe(andJoinRefusalReason(graph));
      })
    );
  });

  it("answers the same after two plain arms from one outlet of a reachable node are joined", () => {
    fc.assert(
      fc.property(
        workflowWithReachableNode,
        armLength,
        armLength,
        fc.boolean(),
        ({ graph, from }, leftLength, rightLength, second) => {
          const extended = withJoin({
            graph,
            arms: [
              {
                source: from,
                second,
                nodes: arm({ prefix: "new-left", length: leftLength }),
              },
              {
                source: from,
                second,
                nodes: arm({ prefix: "new-right", length: rightLength }),
              },
            ],
          });

          expect(andJoinRefusalReason(extended)).toBe(
            andJoinRefusalReason(graph)
          );
        }
      )
    );
  });

  it("refuses joining the two outlets of one exclusive split, wherever the split sits", () => {
    const splitArbitrary = fc.constantFrom(
      "condition" as const,
      "eventSplit" as const,
      "lifecycle" as const
    );
    fc.assert(
      fc.property(
        workflowWithReachableNode,
        splitArbitrary,
        armLength,
        armLength,
        ({ graph, from }, splitKind, leftLength, rightLength) => {
          // The Lifecycle Node splits on its own; a Condition or an Event
          // Split is a fresh node behind the chosen reachable node.
          const fresh = workflowNode({ id: "new-split", kind: splitKind });
          const split = splitKind === "lifecycle" ? entryNode(graph) : fresh;
          const extended = withJoin({
            graph,
            extraNodes: splitKind === "lifecycle" ? [] : [fresh],
            extraEdges:
              splitKind === "lifecycle"
                ? []
                : [edge({ source: from, target: fresh.id })],
            arms: [
              {
                source: split,
                nodes: arm({ prefix: "new-left", length: leftLength }),
              },
              {
                source: split,
                second: true,
                nodes: arm({ prefix: "new-right", length: rightLength }),
              },
            ],
          });

          const reason = andJoinRefusalReason(extended);

          expect(reason).not.toBeNull();
          if (andJoinRefusalReason(graph) === null) {
            expect(reason).toBe(
              splitKind === "lifecycle"
                ? `Node "${JOIN_ID}" cannot join the Started and Canceled branches`
                : `Node "${JOIN_ID}" cannot join mutually exclusive branches from "new-split"`
            );
          }
        }
      )
    );
  });

  it("refuses a join with a Wait anywhere on one of its arms", () => {
    const inputArbitrary = fc
      .tuple(armLength, armLength)
      .chain(([leftLength, rightLength]) =>
        fc.record({
          leftLength: fc.constant(leftLength),
          rightLength: fc.constant(rightLength),
          waitAt: fc.nat(leftLength - 1),
        })
      );
    fc.assert(
      fc.property(
        workflowWithReachableNode,
        inputArbitrary,
        fc.boolean(),
        ({ graph, from }, { leftLength, rightLength, waitAt }, second) => {
          const extended = withJoin({
            graph,
            arms: [
              {
                source: from,
                second,
                nodes: arm({ prefix: "new-left", length: leftLength, waitAt }),
              },
              {
                source: from,
                second,
                nodes: arm({ prefix: "new-right", length: rightLength }),
              },
            ],
          });

          const reason = andJoinRefusalReason(extended);

          expect(reason).not.toBeNull();
          if (andJoinRefusalReason(graph) === null) {
            expect(reason).toBe(
              `Node "${JOIN_ID}" cannot join branches that include a Wait (found "new-left-${waitAt}")`
            );
          }
        }
      )
    );
  });

  // The Wait sits above a fork into two of the three arms, so it is on an arm:
  // the third arm's predecessor has not run through it.
  it("refuses a join with a Wait that some but not all of its arms run through", () => {
    fc.assert(
      fc.property(
        workflowWithReachableNode,
        fc.tuple(armLength, armLength, armLength),
        fc.boolean(),
        ({ graph, from }, [firstLength, secondLength, thirdLength], second) => {
          const wait = workflowNode({ id: "new-wait", kind: "wait" });
          const extended = withJoin({
            graph,
            extraNodes: [wait],
            extraEdges: [edge({ source: from, target: wait.id, second })],
            arms: [
              {
                source: wait,
                nodes: arm({ prefix: "new-first", length: firstLength }),
              },
              {
                source: wait,
                nodes: arm({ prefix: "new-second", length: secondLength }),
              },
              {
                source: from,
                second,
                nodes: arm({ prefix: "new-third", length: thirdLength }),
              },
            ],
          });

          const reason = andJoinRefusalReason(extended);

          expect(reason).not.toBeNull();
          if (andJoinRefusalReason(graph) === null) {
            expect(reason).toBe(
              `Node "${JOIN_ID}" cannot join branches that include a Wait (found "new-wait")`
            );
          }
        }
      )
    );
  });

  it("refuses a join with a branch no run can reach", () => {
    fc.assert(
      fc.property(
        workflowWithReachableNode,
        armLength,
        fc.boolean(),
        ({ graph, from }, leftLength, second) => {
          const orphan = workflowNode({ id: "new-orphan", kind: "step" });
          const extended = withJoin({
            graph,
            extraNodes: [orphan],
            arms: [
              {
                source: from,
                second,
                nodes: arm({ prefix: "new-left", length: leftLength }),
              },
              { source: orphan, nodes: [] },
            ],
          });

          const reason = andJoinRefusalReason(extended);

          expect(reason).not.toBeNull();
          if (andJoinRefusalReason(graph) === null) {
            expect(reason).toBe(
              `Node "${JOIN_ID}" cannot join an unreachable branch (found "new-orphan")`
            );
          }
        }
      )
    );
  });

  it("refuses every graph in which a join's arms hold a Wait", () => {
    fc.assert(
      fc.property(workflowArbitrary, (graph) => {
        const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
        const waitOnArm = andJoinArms(graph).some((join) =>
          [...join.armNodeIds].some((id) => isWaitNode(nodeById.get(id)))
        );

        if (waitOnArm) {
          expect(andJoinRefusalReason(graph)).not.toBeNull();
        }
      })
    );
  });
});
