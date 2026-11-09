/**
 * fast-check building blocks for the graph law tests: a small node id alphabet,
 * the kinds of node a workflow holds, and a builder that turns a kind into a
 * `WorkflowNode`. Drawing every id and every `parentId` from one short list is
 * what makes generated graphs share parents and name existing nodes often.
 */

import * as fc from "fast-check";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import type { WorkflowNode } from "#src/graph/types";
import { omitUndefined } from "#src/utils/omit-undefined";

/**
 * The ids generated graphs use. `constructor` and `__proto__` are here because
 * code that groups nodes by id in a plain object answers them wrongly.
 */
export const NODE_IDS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "constructor",
  "__proto__",
] as const;

/** The kinds of node a workflow graph holds, each built by `workflowNode`. */
export type NodeKind =
  | "lifecycle"
  | "step"
  | "condition"
  | "wait"
  | "eventSplit"
  | "group"
  | "add";

/** An ordinary action step's action type. */
const LOOKUP_ACTION = "custom/lookup";

const ACTION_TYPE_BY_KIND = {
  step: LOOKUP_ACTION,
  condition: BUILT_IN_ACTION_IDS.condition,
  wait: BUILT_IN_ACTION_IDS.wait,
  eventSplit: BUILT_IN_ACTION_IDS.eventSplit,
} as const;

/** Whether a node kind is an action step, which is what a Group may hold. */
export function isActionKind(
  kind: NodeKind
): kind is keyof typeof ACTION_TYPE_BY_KIND {
  return kind in ACTION_TYPE_BY_KIND;
}

/**
 * A node of `kind` labelled with its id. `parentId` is left off the node when
 * it is undefined, the way a stored top-level node carries none.
 */
export function workflowNode(input: {
  id: string;
  kind: NodeKind;
  parentId?: string | undefined;
  position?: { x: number; y: number } | undefined;
  size?: { width: number; height: number } | undefined;
}): WorkflowNode {
  const { kind } = input;
  const type = isActionKind(kind) ? "action" : kind;
  const config = isActionKind(kind)
    ? { actionType: ACTION_TYPE_BY_KIND[kind] }
    : {};
  return omitUndefined({
    id: input.id,
    type,
    position: input.position ?? { x: 0, y: 0 },
    data: { label: input.id, type, config },
    parentId: input.parentId,
    width: input.size?.width,
    height: input.size?.height,
  });
}

/** Any node kind, weighted toward ordinary steps and Group frames. */
export const nodeKindArbitrary: fc.Arbitrary<NodeKind> = fc.oneof(
  { arbitrary: fc.constant("step" as const), weight: 4 },
  { arbitrary: fc.constant("group" as const), weight: 3 },
  {
    arbitrary: fc.constantFrom(
      "lifecycle" as const,
      "condition" as const,
      "wait" as const,
      "eventSplit" as const,
      "add" as const
    ),
    weight: 3,
  }
);
