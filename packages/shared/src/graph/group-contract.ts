/**
 * The v1 Group rules Publish holds a Group to beyond the draft save's own
 * `groupStructureRefusalReason` and `andJoinRefusalReason`. Publication and the
 * editor's workflow issues both call `groupContractViolations`, so they agree.
 * A draft that breaks these rules still saves. No message quotes a config value.
 */

import { compact } from "es-toolkit/array";
import { isConditionActionNode } from "#src/conditions/condition-branch";
import { type AndJoin, andJoinArms } from "#src/graph/and-join";
import {
  analyzeGroupBoundary,
  type GroupGraphNode,
  isGroupNode,
} from "#src/graph/group-boundary";
import { nodeLabel } from "#src/graph/group-structure";
import { isEventSplitActionNode } from "#src/graph/node-config";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";

export type GroupContractRule =
  /** A Group holds fewer than two steps that a Group may contain. */
  | "too_few_members"
  /** A member is an Event Split. */
  | "disallowed_member"
  /** Stored edges enter the Group from more than one outside source port. */
  | "multiple_ingress_sources"
  /** Stored edges leave the Group from more than one member source port. */
  | "multiple_continuations"
  /** A join inside the Group has an arm node or a predecessor outside it. */
  | "join_crosses_boundary"
  /** A Condition inside the Group lies on an arm of a join. */
  | "conditional_join_arm";

export type GroupContractViolation = {
  groupId: string;
  groupLabel: string;
  rule: GroupContractRule;
  message: string;
};

type RuleBreak = Pick<GroupContractViolation, "rule" | "message">;

/** Whether a member is a step a Group may contain: any action but an Event Split. */
function isGroupableStep(node: GroupGraphNode): boolean {
  return node.data.type === "action" && !isEventSplitActionNode(node);
}

/**
 * How many members of the Group `groupId` are steps a Group may contain. A
 * Group needs at least two. The Lifecycle Node, an Add node, another Group and
 * an Event Split are not counted.
 */
export function groupStepCount(input: {
  groupId: string;
  nodes: readonly GroupGraphNode[];
}): number {
  return input.nodes.filter(
    (node) => node.parentId === input.groupId && isGroupableStep(node)
  ).length;
}

function labelOf(
  nodeId: string,
  nodeById: ReadonlyMap<string, WorkflowNode>
): string {
  const node = nodeById.get(nodeId);
  return node ? nodeLabel(node) : nodeId;
}

/**
 * The join rules a Group breaks for one join. A join whose node is inside the
 * Group must have every arm node and every predecessor inside it too. A join
 * outside the Group may have the Group on an arm. Either way, a Condition member
 * on an arm is refused, because the branch it does not take leaves the join
 * unreleased.
 */
function joinRuleBreaks(input: {
  groupName: string;
  join: AndJoin;
  memberIds: ReadonlySet<string>;
  nodeById: ReadonlyMap<string, WorkflowNode>;
}): RuleBreak[] {
  const { groupName, join, memberIds, nodeById } = input;
  const joinName = `"${labelOf(join.joinNodeId, nodeById)}"`;
  const joinInside = memberIds.has(join.joinNodeId);
  const reachesOutside = [...join.armNodeIds, ...join.predecessorIds].some(
    (id) => !memberIds.has(id)
  );
  const condition = [...join.armNodeIds].find((id) => {
    const node = nodeById.get(id);
    return (
      memberIds.has(id) && node !== undefined && isConditionActionNode(node)
    );
  });

  return compact([
    joinInside && reachesOutside
      ? {
          rule: "join_crosses_boundary",
          message: `${groupName} holds the join at ${joinName}, and a branch into it starts outside the Group. Put every branch into the join inside the Group`,
        }
      : undefined,
    condition === undefined
      ? undefined
      : {
          rule: "conditional_join_arm",
          message: `${groupName} has "${labelOf(condition, nodeById)}" on a branch into the join at ${joinName}, and the Condition can end that branch before the join runs`,
        },
  ] satisfies Array<RuleBreak | undefined>);
}

function violationsForGroup(input: {
  group: WorkflowNode;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  joins: readonly AndJoin[];
  nodeById: ReadonlyMap<string, WorkflowNode>;
}): GroupContractViolation[] {
  const { group, nodes, edges, joins, nodeById } = input;
  const groupName = `Group "${nodeLabel(group)}"`;
  const members = nodes.filter((node) => node.parentId === group.id);
  const memberIds = new Set(members.map((node) => node.id));
  const boundary = analyzeGroupBoundary({ memberIds: [...memberIds], edges });
  const { externalIngress, internalContinuation } = boundary;

  const found: RuleBreak[] = compact([
    groupStepCount({ groupId: group.id, nodes }) < 2
      ? {
          rule: "too_few_members",
          message: `${groupName} needs at least two steps`,
        }
      : undefined,
    ...members
      .filter((member) => isEventSplitActionNode(member))
      .map((member): RuleBreak => ({
        rule: "disallowed_member",
        message: `${groupName} cannot contain an Event Split ("${nodeLabel(member)}")`,
      })),
    externalIngress.length > 1
      ? {
          rule: "multiple_ingress_sources",
          message: `${groupName} is entered from ${externalIngress.length} outlets outside it. Connect the Group from one outlet`,
        }
      : undefined,
    internalContinuation.length > 1
      ? {
          rule: "multiple_continuations",
          message: `${groupName} continues from ${internalContinuation.length} outlets inside it. Only one outlet inside a Group can connect to steps outside it`,
        }
      : undefined,
    ...joins.flatMap((join) =>
      joinRuleBreaks({ groupName, join, memberIds, nodeById })
    ),
  ] satisfies Array<RuleBreak | undefined>);

  return found.map((violation) => ({
    groupId: group.id,
    groupLabel: nodeLabel(group),
    ...violation,
  }));
}

/**
 * Every v1 Group rule the graph breaks, for each Group frame in node order. An
 * empty list means every Group may be published. Membership integrity, such as
 * a `parentId` naming a missing node, is `groupStructureRefusalReason`'s check.
 */
export function groupContractViolations(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): GroupContractViolation[] {
  const groups = input.nodes.filter((node) => isGroupNode(node));
  if (groups.length === 0) {
    return [];
  }
  // A Map, because node ids are chosen by the builder and a plain object would
  // answer a node named `constructor` with a prototype member.
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const joins = andJoinArms(input);
  return groups.flatMap((group) =>
    violationsForGroup({
      group,
      nodes: input.nodes,
      edges: input.edges,
      joins,
      nodeById,
    })
  );
}
