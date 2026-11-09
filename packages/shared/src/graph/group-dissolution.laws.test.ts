/**
 * The laws `group-dissolution.ts` states in its headers, checked against
 * generated graphs. Generated nodes draw ids and `parentId`s from one short
 * list, so frames share members, members name missing or non-frame parents,
 * and `groupIds` names frames, steps and missing nodes alike.
 */

import * as fc from "fast-check";
import { partition } from "es-toolkit/array";
import { omit } from "es-toolkit/object";
import { describe, expect, it } from "vitest";
import {
  isActionKind,
  NODE_IDS,
  nodeKindArbitrary,
  workflowNode,
} from "#src/graph/graph-arbitraries-test-support";
import { isGroupNode } from "#src/graph/group-boundary";
import {
  dissolveGroups,
  releaseAtGroupCanvasPosition,
  repairGroups,
  type ReleaseMember,
} from "#src/graph/group-dissolution";
import {
  groupStructureRefusalReason,
  type GroupStructureEdge,
} from "#src/graph/group-structure";
import { undersizedGroupIds } from "#src/graph/node-group";
import { overlappingCardIds } from "#src/graph/node-placement-test-support";
import type { WorkflowNode } from "#src/graph/types";

/** An id no generated node holds, for a `parentId` or Group id naming nothing. */
const MISSING_ID = "gone";

const coordinate = fc.integer({ min: 0, max: 800 });

/**
 * Where a generated node's `parentId` points: nowhere, at one of the generated
 * Group frames (picked by index once the frames are known), or at any id,
 * which may name a step, the node itself, or no node.
 */
const parentArbitrary = fc.oneof(
  { arbitrary: fc.constant({ to: "none" as const }), weight: 2 },
  {
    arbitrary: fc.nat().map((pick) => ({ to: "frame" as const, pick })),
    weight: 4,
  },
  {
    arbitrary: fc
      .constantFrom(...NODE_IDS, MISSING_ID)
      .map((id) => ({ to: "id" as const, id })),
    weight: 1,
  }
);

/**
 * Nodes of every kind with unique ids, canvas positions close enough for cards
 * to overlap, and a `parentId` that usually names a generated frame.
 */
const nodesArbitrary: fc.Arbitrary<WorkflowNode[]> = fc
  .uniqueArray(
    fc.record({
      id: fc.constantFrom(...NODE_IDS),
      kind: nodeKindArbitrary,
      parent: parentArbitrary,
      position: fc.record({ x: coordinate, y: coordinate }),
      size: fc.option(
        fc.record({
          width: fc.integer({ min: 40, max: 400 }),
          height: fc.integer({ min: 40, max: 300 }),
        }),
        { nil: undefined }
      ),
    }),
    { selector: (spec) => spec.id, minLength: 2, maxLength: NODE_IDS.length }
  )
  .map((specs) => {
    const frameIds = specs
      .filter((spec) => spec.kind === "group")
      .map((spec) => spec.id);
    return specs.map(({ parent, ...spec }) => {
      if (parent.to === "id") {
        return workflowNode({ ...spec, parentId: parent.id });
      }
      if (parent.to === "frame") {
        return workflowNode({
          ...spec,
          parentId: frameIds[parent.pick % frameIds.length],
        });
      }
      return workflowNode(spec);
    });
  });

/**
 * Group ids for `nodes`: at least one of its frames when it has any, plus some
 * ids that name a step or no node, which dissolution ignores.
 */
function groupIdsFor(
  nodes: readonly WorkflowNode[]
): fc.Arbitrary<ReadonlySet<string>> {
  const [frames, others] = partition(nodes, isGroupNode);
  const frameIds = frames.map((node) => node.id);
  const otherIds = others.map((node) => node.id);
  return fc
    .tuple(
      fc.subarray(frameIds, { minLength: Math.min(1, frameIds.length) }),
      fc.subarray([...otherIds, MISSING_ID])
    )
    .map(([someFrames, someOthers]) => new Set([...someFrames, ...someOthers]));
}

const dissolutionArbitrary = nodesArbitrary.chain((nodes) =>
  fc.record({ nodes: fc.constant(nodes), groupIds: groupIdsFor(nodes) })
);

/** Stored edges between any two generated ids, which may name a frame or no node. */
const edgesArbitrary: fc.Arbitrary<GroupStructureEdge[]> = fc
  .array(
    fc.tuple(
      fc.constantFrom(...NODE_IDS, MISSING_ID),
      fc.constantFrom(...NODE_IDS, MISSING_ID)
    ),
    { maxLength: 6 }
  )
  .map((pairs) =>
    pairs.map(([source, target], index) => ({
      id: `edge-${index}`,
      source,
      target,
    }))
  );

/**
 * Graphs whose Group structure `groupStructureRefusalReason` accepts: frames sit
 * in no frame, only action steps are members and name an existing frame, and no
 * edge touches a frame. Frames of every size occur, including empty ones.
 */
const structuredGraphArbitrary = fc
  .record({
    specs: fc.uniqueArray(
      fc.record({
        id: fc.constantFrom(...NODE_IDS),
        kind: nodeKindArbitrary,
        frameChoice: fc.option(fc.nat(), { nil: undefined }),
        position: fc.record({ x: coordinate, y: coordinate }),
      }),
      { selector: (spec) => spec.id, maxLength: NODE_IDS.length }
    ),
    edgePairs: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 6 }),
  })
  .map(({ specs, edgePairs }) => {
    const frameIds = specs
      .filter((spec) => spec.kind === "group")
      .map((spec) => spec.id);
    const nodes = specs.map((spec) =>
      workflowNode({
        ...spec,
        parentId:
          isActionKind(spec.kind) &&
          spec.frameChoice !== undefined &&
          frameIds.length > 0
            ? frameIds[spec.frameChoice % frameIds.length]
            : undefined,
      })
    );
    const endIds = specs
      .filter((spec) => spec.kind !== "group")
      .map((spec) => spec.id);
    const edges: GroupStructureEdge[] =
      endIds.length === 0
        ? []
        : edgePairs.map(([source, target], index) => ({
            id: `edge-${index}`,
            source: endIds[source % endIds.length] ?? "",
            target: endIds[target % endIds.length] ?? "",
          }));
    return { nodes, edges };
  });

/** The Group frames dissolution removes: each node named in `groupIds` that is a frame. */
function removedFrames(input: {
  nodes: readonly WorkflowNode[];
  groupIds: ReadonlySet<string>;
}): Map<string, WorkflowNode> {
  return new Map(
    input.nodes
      .filter((node) => input.groupIds.has(node.id) && isGroupNode(node))
      .map((node) => [node.id, node])
  );
}

/** The nodes dissolution releases: each kept node whose `parentId` names a removed frame. */
function releasedMembers(input: {
  nodes: readonly WorkflowNode[];
  groupIds: ReadonlySet<string>;
}): WorkflowNode[] {
  const frames = removedFrames(input);
  return input.nodes.filter(
    (node) =>
      !frames.has(node.id) &&
      node.parentId !== undefined &&
      frames.has(node.parentId)
  );
}

/** Nodes by id, in a Map because generated ids include prototype member names. */
function nodeById(nodes: readonly WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** The node `id` names in `byId`, failing the property when there is none. */
function required(
  byId: ReadonlyMap<string, WorkflowNode>,
  id: string
): WorkflowNode {
  const node = byId.get(id);
  if (!node) {
    throw new Error(`Expected a node with id ${id}`);
  }
  return node;
}

function dissolveAtCanvasPosition(input: {
  nodes: readonly WorkflowNode[];
  groupIds: ReadonlySet<string>;
}) {
  return dissolveGroups({
    nodes: input.nodes,
    groupIds: input.groupIds,
    releaseMember: releaseAtGroupCanvasPosition({ nodes: input.nodes }),
  });
}

/** A release that reads the member alone: the member without its `parentId`. */
const dropParent: ReleaseMember<WorkflowNode> = ({ member }) =>
  omit(member, ["parentId"]);

describe("dissolveGroups laws", () => {
  it("removes exactly the Group frames groupIds names and keeps every other node in order", () => {
    fc.assert(
      fc.property(dissolutionArbitrary, (input) => {
        const frames = removedFrames(input);

        const dissolved = dissolveAtCanvasPosition(input);

        expect(dissolved.map((node) => node.id)).toEqual(
          input.nodes
            .filter((node) => !frames.has(node.id))
            .map((node) => node.id)
        );
      })
    );
  });

  it("builds each member of a removed frame with releaseMember and keeps every other node as given", () => {
    fc.assert(
      fc.property(dissolutionArbitrary, (input) => {
        const frames = removedFrames(input);
        // A Map, because generated ids include prototype member names.
        const builtById = new Map<string, WorkflowNode>();
        const releaseMember: ReleaseMember<WorkflowNode> = ({
          frame,
          member,
        }) => {
          expect(frame).toBe(frames.get(member.parentId ?? ""));
          expect(builtById.has(member.id)).toBe(false);
          const built = dropParent({ frame, member });
          builtById.set(member.id, built);
          return built;
        };

        const dissolved = dissolveGroups({ ...input, releaseMember });

        expect([...builtById.keys()]).toEqual(
          releasedMembers(input).map((node) => node.id)
        );
        const inputById = nodeById(input.nodes);
        for (const node of dissolved) {
          expect(node).toBe(builtById.get(node.id) ?? inputById.get(node.id));
        }
      })
    );
  });

  it("releases a member at the Group canvas position with its id and data and no parentId", () => {
    fc.assert(
      fc.property(dissolutionArbitrary, (input) => {
        const dissolved = nodeById(dissolveAtCanvasPosition(input));

        for (const member of releasedMembers(input)) {
          const released = required(dissolved, member.id);
          expect(released).not.toHaveProperty("parentId");
          expect(released.data).toBe(member.data);
          expect(omit(released, ["position"])).toEqual(
            omit(member, ["position", "parentId"])
          );
        }
      })
    );
  });

  it("moves the members of one frame together, by one equal step count down and right", () => {
    fc.assert(
      fc.property(dissolutionArbitrary, (input) => {
        const frames = removedFrames(input);
        const dissolved = nodeById(dissolveAtCanvasPosition(input));

        const membersByFrame = Map.groupBy(
          releasedMembers(input),
          (member) => member.parentId ?? ""
        );
        for (const [frameId, members] of membersByFrame) {
          const frame = required(frames, frameId);
          // How far each member landed from where the focused Group canvas
          // draws it, translated by the frame's position.
          const offsets = members.map((member) => {
            const { position } = required(dissolved, member.id);
            return {
              x: position.x - frame.position.x - member.position.x,
              y: position.y - frame.position.y - member.position.y,
            };
          });
          const [first] = offsets;
          expect(first?.x).toBe(first?.y);
          expect(first?.x).toBeGreaterThanOrEqual(0);
          for (const offset of offsets) {
            expect(offset).toEqual(first);
          }
        }
      })
    );
  });

  it("leaves no released member's card overlapping a card outside its own frame", () => {
    fc.assert(
      fc.property(dissolutionArbitrary, (input) => {
        const frameByReleasedId = new Map(
          releasedMembers(input).map((member) => [member.id, member.parentId])
        );

        const dissolved = dissolveAtCanvasPosition(input);

        // Two unmoved nodes may already overlap in the input, and members of
        // one frame keep whatever overlap they had inside it. Every other
        // overlapping pair has a released member on one side only, or members
        // of two different frames.
        const pairsAcrossFrames = overlappingCardIds(dissolved).filter(
          ([left = "", right = ""]) =>
            frameByReleasedId.get(left) !== frameByReleasedId.get(right)
        );
        expect(pairsAcrossFrames).toEqual([]);
      })
    );
  });

  it("changes nothing when it dissolves the same Group ids a second time", () => {
    fc.assert(
      fc.property(dissolutionArbitrary, (input) => {
        const once = dissolveAtCanvasPosition(input);

        expect(dissolveAtCanvasPosition({ ...input, nodes: once })).toBe(once);
      })
    );
  });

  it("answers the given array when groupIds names no Group frame", () => {
    const inputArbitrary = nodesArbitrary.chain((nodes) =>
      fc.record({
        nodes: fc.constant(nodes),
        groupIds: fc
          .subarray([
            ...nodes
              .filter((node) => !isGroupNode(node))
              .map((node) => node.id),
            MISSING_ID,
          ])
          .map((ids): ReadonlySet<string> => new Set(ids)),
      })
    );
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        expect(dissolveAtCanvasPosition(input)).toBe(input.nodes);
      })
    );
  });

  it("dissolves in two passes what it dissolves in one pass over both sets of Group ids", () => {
    const inputArbitrary = nodesArbitrary.chain((nodes) =>
      fc.tuple(fc.constant(nodes), groupIdsFor(nodes), groupIdsFor(nodes))
    );
    fc.assert(
      fc.property(inputArbitrary, ([nodes, first, second]) => {
        const twoPasses = dissolveGroups({
          nodes: dissolveGroups({
            nodes,
            groupIds: first,
            releaseMember: dropParent,
          }),
          groupIds: second,
          releaseMember: dropParent,
        });

        expect(twoPasses).toEqual(
          dissolveGroups({
            nodes,
            groupIds: new Set([...first, ...second]),
            releaseMember: dropParent,
          })
        );
      })
    );
  });
});

describe("repairGroups laws", () => {
  it("refuses a graph whole exactly when its Group structure is refused", () => {
    fc.assert(
      fc.property(nodesArbitrary, edgesArbitrary, (nodes, edges) => {
        const reason = groupStructureRefusalReason({ nodes, edges });

        const repair = repairGroups({
          nodes,
          edges,
          releaseMember: releaseAtGroupCanvasPosition({ nodes }),
        });

        expect(repair).toEqual(
          reason === null
            ? expect.objectContaining({ ok: true })
            : { ok: false, reason }
        );
      })
    );
  });

  it("dissolves each undersized Group and leaves a graph the Group rules accept with none undersized", () => {
    fc.assert(
      fc.property(structuredGraphArbitrary, ({ nodes, edges }) => {
        const repair = repairGroups({
          nodes,
          edges,
          releaseMember: releaseAtGroupCanvasPosition({ nodes }),
        });

        expect(repair.ok).toBe(true);
        if (!repair.ok) {
          return;
        }
        expect(repair.dissolvedGroupIds).toEqual(undersizedGroupIds(nodes));
        expect(
          groupStructureRefusalReason({ nodes: repair.nodes, edges })
        ).toBeNull();
        expect(undersizedGroupIds(repair.nodes)).toEqual([]);
      })
    );
  });

  it("dissolves nothing and answers the same array when repairing a repaired graph", () => {
    fc.assert(
      fc.property(structuredGraphArbitrary, ({ nodes, edges }) => {
        const first = repairGroups({
          nodes,
          edges,
          releaseMember: releaseAtGroupCanvasPosition({ nodes }),
        });
        if (!first.ok) {
          return;
        }

        const second = repairGroups({
          nodes: first.nodes,
          edges,
          releaseMember: releaseAtGroupCanvasPosition({ nodes: first.nodes }),
        });

        expect(second.ok && second.dissolvedGroupIds).toEqual([]);
        expect(second.ok && second.nodes).toBe(first.nodes);
      })
    );
  });
});
