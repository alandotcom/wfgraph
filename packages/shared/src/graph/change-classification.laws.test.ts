/**
 * The laws `change-classification.ts` states in its header, checked against
 * generated comparisons. Each generated node may sit in the published graph,
 * the draft graph or both, as a Group frame or another kind, so a node that
 * turns from a frame into a step or back occurs alongside ordinary changes.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyWorkflowComparison,
  isGroupFrameChange,
  nodeChangeCategories,
} from "#src/graph/change-classification";
import { createSerializedWorkflowGraph } from "#src/graph/graph";
import {
  isActionKind,
  NODE_IDS,
  workflowNode,
  type NodeKind,
} from "#src/graph/graph-arbitraries-test-support";
import type {
  WorkflowEdgeChange,
  WorkflowFieldChange,
  WorkflowNodeChange,
} from "#src/graph/publication-contracts";

/** The membership field's path, the one field of a step that is Organization. */
const MEMBERSHIP_PATH: readonly string[] = ["parentId"];

/**
 * Field paths other than membership that a node change records.
 * `data.config.parentId` is a config key that happens to share the membership
 * field's name, and is Behavior.
 */
const OTHER_FIELD_PATHS: readonly (readonly string[])[] = [
  ["data", "label"],
  ["data", "enabled"],
  ["data", "config", "actionType"],
  ["data", "config", "parentId"],
  ["position", "x"],
];

/** A recorded field, often the membership field so membership-only changes occur. */
const fieldArbitrary: fc.Arbitrary<WorkflowFieldChange> = fc.record({
  path: fc
    .oneof(
      { arbitrary: fc.constant(MEMBERSHIP_PATH), weight: 3 },
      { arbitrary: fc.constantFrom(...OTHER_FIELD_PATHS), weight: 4 }
    )
    .map((path) => [...path]),
  kind: fc.constantFrom(
    "added" as const,
    "modified" as const,
    "removed" as const
  ),
});

/** A node's kind in one graph, or undefined where that graph does not hold it. */
const sideArbitrary: fc.Arbitrary<NodeKind | undefined> = fc.oneof(
  { arbitrary: fc.constant(undefined), weight: 1 },
  { arbitrary: fc.constant("group" as const), weight: 2 },
  {
    arbitrary: fc.constantFrom(
      "step" as const,
      "condition" as const,
      "lifecycle" as const
    ),
    weight: 2,
  }
);

type NodeSides = { before: string | undefined; after: string | undefined };

/**
 * One comparison: the published and draft graphs, a change for each node the
 * two graphs disagree on, some edge changes, and each changed node's
 * `data.type` on both sides. A change's kind follows from which graphs hold
 * the node, the way the publication diff writes it.
 */
const comparisonArbitrary = fc
  .record({
    nodes: fc.uniqueArray(
      fc.record({
        id: fc.constantFrom(...NODE_IDS),
        before: sideArbitrary,
        after: sideArbitrary,
        fields: fc.array(fieldArbitrary, { maxLength: 4 }),
      }),
      { selector: (spec) => spec.id, maxLength: NODE_IDS.length }
    ),
    edgeChanges: fc.array(
      fc.record({
        edgeId: fc.constantFrom("x", "y", "z"),
        kind: fc.constantFrom("added" as const, "removed" as const),
      }),
      { maxLength: 2 }
    ),
  })
  .map(({ nodes, edgeChanges }) => {
    const held = nodes.filter(
      (spec) => spec.before !== undefined || spec.after !== undefined
    );
    const graphOf = (side: "before" | "after") =>
      createSerializedWorkflowGraph({
        nodes: held.flatMap((spec) => {
          const kind = spec[side];
          return kind === undefined
            ? []
            : [workflowNode({ id: spec.id, kind })];
        }),
        edges: [],
      });
    const nodeChanges: WorkflowNodeChange[] = held.map((spec) => ({
      nodeId: spec.id,
      kind:
        spec.before === undefined
          ? "added"
          : spec.after === undefined
            ? "removed"
            : "modified",
      fields: spec.fields,
    }));
    // A Map, because generated ids include prototype member names.
    const sidesById = new Map<string, NodeSides>(
      held.map((spec) => [
        spec.id,
        { before: dataType(spec.before), after: dataType(spec.after) },
      ])
    );
    const payload = {
      baseGraph: graphOf("before"),
      draftGraph: graphOf("after"),
      nodeChanges,
      edgeChanges: edgeChanges satisfies WorkflowEdgeChange[],
    };
    return { payload, sidesById };
  });

/** The `data.type` a node of `kind` stores. */
function dataType(kind: NodeKind | undefined): string | undefined {
  if (kind === undefined) {
    return undefined;
  }
  return isActionKind(kind) ? "action" : kind;
}

/** Whether every graph holding the node holds it as a Group frame. */
function isFrameOnEverySide(sides: NodeSides | undefined): boolean {
  return [sides?.before, sides?.after].every(
    (type) => type === undefined || type === "group"
  );
}

function isMembership(field: WorkflowFieldChange): boolean {
  return (
    field.path.length === MEMBERSHIP_PATH.length &&
    field.path[0] === MEMBERSHIP_PATH[0]
  );
}

describe("classifyWorkflowComparison laws", () => {
  it("puts every change to a node that is a Group frame on each side holding it in Organization alone", () => {
    fc.assert(
      fc.property(comparisonArbitrary, ({ payload, sidesById }) => {
        const categories = classifyWorkflowComparison(payload);

        for (const change of payload.nodeChanges) {
          const frame = isFrameOnEverySide(sidesById.get(change.nodeId));
          expect(categories.groupFrameIds.has(change.nodeId)).toBe(frame);
          if (frame) {
            expect(categories.nodes.get(change.nodeId)).toEqual({
              organization: true,
              behavior: false,
            });
          }
        }
      })
    );
  });

  it("puts an added or removed node that is not a Group frame on every side in Behavior alone, whatever fields it records", () => {
    fc.assert(
      fc.property(comparisonArbitrary, ({ payload, sidesById }) => {
        const categories = classifyWorkflowComparison(payload);

        for (const change of payload.nodeChanges) {
          if (
            change.kind !== "modified" &&
            !isFrameOnEverySide(sidesById.get(change.nodeId))
          ) {
            expect(categories.nodes.get(change.nodeId)).toEqual({
              organization: false,
              behavior: true,
            });
          }
        }
      })
    );
  });

  it("puts a modified step that records only its Group membership in Organization and never in Behavior", () => {
    fc.assert(
      fc.property(comparisonArbitrary, ({ payload, sidesById }) => {
        const categories = classifyWorkflowComparison(payload);

        for (const change of payload.nodeChanges) {
          if (
            change.kind === "modified" &&
            change.fields.length > 0 &&
            change.fields.every(isMembership) &&
            !isFrameOnEverySide(sidesById.get(change.nodeId))
          ) {
            expect(categories.nodes.get(change.nodeId)).toEqual({
              organization: true,
              behavior: false,
            });
          }
        }
      })
    );
  });

  it("puts a modified step in Behavior exactly when it records no field or a field other than its membership", () => {
    fc.assert(
      fc.property(comparisonArbitrary, ({ payload, sidesById }) => {
        const categories = classifyWorkflowComparison(payload);

        for (const change of payload.nodeChanges) {
          if (
            change.kind === "modified" &&
            !isFrameOnEverySide(sidesById.get(change.nodeId))
          ) {
            expect(categories.nodes.get(change.nodeId)).toEqual({
              organization: change.fields.some(isMembership),
              behavior:
                change.fields.length === 0 ||
                change.fields.some((field) => !isMembership(field)),
            });
          }
        }
      })
    );
  });

  it("puts every node change in at least one category", () => {
    fc.assert(
      fc.property(comparisonArbitrary, ({ payload }) => {
        const categories = classifyWorkflowComparison(payload);

        expect([...categories.nodes.keys()]).toEqual(
          payload.nodeChanges.map((change) => change.nodeId)
        );
        for (const node of categories.nodes.values()) {
          expect(node.organization || node.behavior).toBe(true);
        }
      })
    );
  });

  it("touches a category exactly when a node change does, and Behavior also when any edge changed", () => {
    fc.assert(
      fc.property(comparisonArbitrary, ({ payload }) => {
        const categories = classifyWorkflowComparison(payload);
        const nodes = [...categories.nodes.values()];

        expect(categories.organization).toBe(
          nodes.some((node) => node.organization)
        );
        expect(categories.behavior).toBe(
          payload.edgeChanges.length > 0 || nodes.some((node) => node.behavior)
        );
      })
    );
  });

  it("classifies the changes in two parts the way it classifies them together", () => {
    const inputArbitrary = comparisonArbitrary.chain((comparison) =>
      fc.record({
        comparison: fc.constant(comparison),
        nodeSplit: fc.nat(comparison.payload.nodeChanges.length),
        edgeSplit: fc.nat(comparison.payload.edgeChanges.length),
      })
    );
    fc.assert(
      fc.property(inputArbitrary, ({ comparison, nodeSplit, edgeSplit }) => {
        const { payload } = comparison;
        const parts = [
          {
            ...payload,
            nodeChanges: payload.nodeChanges.slice(0, nodeSplit),
            edgeChanges: payload.edgeChanges.slice(0, edgeSplit),
          },
          {
            ...payload,
            nodeChanges: payload.nodeChanges.slice(nodeSplit),
            edgeChanges: payload.edgeChanges.slice(edgeSplit),
          },
        ].map(classifyWorkflowComparison);

        const whole = classifyWorkflowComparison(payload);

        expect(whole.organization).toBe(
          parts.some((part) => part.organization)
        );
        expect(whole.behavior).toBe(parts.some((part) => part.behavior));
        expect(whole.nodes).toEqual(
          new Map(parts.flatMap((part) => [...part.nodes]))
        );
        expect(whole.groupFrameIds).toEqual(
          new Set(parts.flatMap((part) => [...part.groupFrameIds]))
        );
      })
    );
  });
});

describe("nodeChangeCategories laws", () => {
  it("does not depend on the order a change records its fields in", () => {
    const inputArbitrary = fc
      .record({
        nodeId: fc.constantFrom(...NODE_IDS),
        kind: fc.constantFrom(
          "added" as const,
          "modified" as const,
          "removed" as const
        ),
        fields: fc.array(fieldArbitrary, { maxLength: 5 }),
        groupFrame: fc.boolean(),
      })
      .chain((input) =>
        fc.record({
          input: fc.constant(input),
          reordered: fc.shuffledSubarray(input.fields, {
            minLength: input.fields.length,
          }),
        })
      );
    fc.assert(
      fc.property(inputArbitrary, ({ input, reordered }) => {
        const { groupFrame, ...change } = input;

        expect(
          nodeChangeCategories({
            change: { ...change, fields: reordered },
            groupFrame,
          })
        ).toEqual(nodeChangeCategories({ change, groupFrame }));
      })
    );
  });
});

describe("isGroupFrameChange laws", () => {
  it("answers the same with the two graphs swapped", () => {
    const side = fc.option(fc.constantFrom("group", "action", "lifecycle"), {
      nil: undefined,
    });
    fc.assert(
      fc.property(side, side, (before, after) => {
        expect(isGroupFrameChange({ before, after })).toBe(
          isGroupFrameChange({ before: after, after: before })
        );
      })
    );
  });
});
