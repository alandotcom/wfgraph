/**
 * The v1 Group rules Publish holds a Group to beyond the draft save's own
 * `groupStructureRefusalReason` and `andJoinRefusalReason`. Publication and the
 * editor's workflow issues both call `groupContractViolations`, so they agree.
 * A draft that breaks these rules still saves. No message quotes a config value.
 */

import { compact, uniq } from "es-toolkit/array";
import {
  getConditionBranchDisplayLabel,
  isConditionActionNode,
} from "#src/conditions/condition-branch";
import { type AndJoin, andJoinArms } from "#src/graph/and-join";
import {
  analyzeGroupBoundary,
  analyzeGroupBoundaryById,
  type GroupBoundary,
  type GroupBoundaryEdge,
  type GroupGraphNode,
  type GroupPort,
  isGroupNode,
} from "#src/graph/group-boundary";
import { nodeLabel } from "#src/graph/group-structure";
import { isEventSplitActionNode } from "#src/graph/node-config";
import { eventSplitOutletEvent } from "#src/lifecycle/event-split";
import type { WorkflowEdge } from "#src/graph/types";

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

/** One rule a Group breaks, before it is tied to a frame id. */
export type GroupRuleBreak = Pick<GroupContractViolation, "rule" | "message">;

/** Whether a member is a step a Group may contain: any action but an Event Split. */
export function isGroupableStep(node: GroupGraphNode): boolean {
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
  nodeById: ReadonlyMap<string, GroupGraphNode>
): string {
  const node = nodeById.get(nodeId);
  return node ? nodeLabel(node) : nodeId;
}

/**
 * A source port as a message names it: the quoted step label, and the Condition
 * branch or Event Split outlet when the port's handle names one.
 */
function portLabel(
  port: GroupPort,
  nodeById: ReadonlyMap<string, GroupGraphNode>
): string {
  const step = `"${labelOf(port.nodeId, nodeById)}"`;
  const outlet =
    getConditionBranchDisplayLabel(port.handle) ??
    eventSplitOutletEvent(port.handle);
  return outlet === null ? step : `the "${outlet}" outlet of ${step}`;
}

/** Whether stored edges enter a Group from more than one outside source port. */
function entersFromSeveralPorts(
  boundary: Pick<GroupBoundary<GroupBoundaryEdge>, "externalIngress">
): boolean {
  return boundary.externalIngress.length > 1;
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
  nodeById: ReadonlyMap<string, GroupGraphNode>;
}): GroupRuleBreak[] {
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
  ] satisfies Array<GroupRuleBreak | undefined>);
}

function ruleBreaksForMembers(input: {
  groupLabel: string;
  memberIds: ReadonlySet<string>;
  nodes: readonly GroupGraphNode[];
  edges: readonly WorkflowEdge[];
  joins: readonly AndJoin[];
  nodeById: ReadonlyMap<string, GroupGraphNode>;
}): GroupRuleBreak[] {
  const { memberIds, nodes, edges, joins, nodeById } = input;
  const groupName = `Group "${input.groupLabel}"`;
  const members = nodes.filter((node) => memberIds.has(node.id));
  const boundary = analyzeGroupBoundary({ memberIds: [...memberIds], edges });
  const { externalIngress, internalContinuation } = boundary;

  return compact([
    members.filter((node) => isGroupableStep(node)).length < 2
      ? {
          rule: "too_few_members",
          message: `${groupName} needs at least two steps`,
        }
      : undefined,
    ...members
      .filter((member) => isEventSplitActionNode(member))
      .map((member): GroupRuleBreak => ({
        rule: "disallowed_member",
        message: `${groupName} cannot contain an Event Split ("${nodeLabel(member)}")`,
      })),
    entersFromSeveralPorts(boundary)
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
  ] satisfies Array<GroupRuleBreak | undefined>);
}

/**
 * Why the editor refuses to add the stored edges `additions` to `edges`: they
 * would enter a Group from more outside source ports than it is entered from
 * now, and from more than one. Null when every Group they touch keeps one
 * source port, or keeps the ports it already had. Adding an edge from a Group's
 * existing source port onto another member is a fan-out and is never refused.
 */
export function addedIngressSourceRefusal(input: {
  nodes: readonly GroupGraphNode[];
  edges: readonly GroupBoundaryEdge[];
  additions: readonly GroupBoundaryEdge[];
}): string | null {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const enteredGroups = uniq(
    input.additions.flatMap((edge) => {
      const parentId = nodeById.get(edge.target)?.parentId;
      return parentId !== undefined && isGroupNode(nodeById.get(parentId))
        ? [parentId]
        : [];
    })
  );
  const after = [...input.edges, ...input.additions];
  for (const groupId of enteredGroups) {
    const before = analyzeGroupBoundaryById({
      nodes: input.nodes,
      edges: input.edges,
      groupId,
    });
    const withAdditions = analyzeGroupBoundaryById({
      nodes: input.nodes,
      edges: after,
      groupId,
    });
    if (
      !entersFromSeveralPorts(withAdditions) ||
      withAdditions.externalIngress.length <= before.externalIngress.length
    ) {
      continue;
    }
    const groupName = `"${labelOf(groupId, nodeById)}"`;
    const [current] = before.externalIngress;
    return current === undefined
      ? `This connection would enter the Group ${groupName} from ${withAdditions.externalIngress.length} outlets. A Group is entered from one outlet.`
      : `The Group ${groupName} is already entered from ${portLabel(current, nodeById)}. A Group is entered from one outlet, so remove that connection first.`;
  }
  return null;
}

/**
 * Every v1 Group rule a Group holding exactly the nodes `memberIds` would break
 * over `nodes` and `edges`, whether or not those nodes are grouped yet. Messages
 * name the Group `groupLabel`.
 */
export function groupRuleBreaks(input: {
  groupLabel: string;
  memberIds: ReadonlySet<string>;
  nodes: readonly GroupGraphNode[];
  edges: readonly WorkflowEdge[];
}): GroupRuleBreak[] {
  return ruleBreaksForMembers({
    ...input,
    joins: andJoinArms(input),
    nodeById: new Map(input.nodes.map((node) => [node.id, node])),
  });
}

/**
 * Every v1 Group rule the graph breaks, for each Group frame in node order. An
 * empty list means every Group may be published. Membership integrity, such as
 * a `parentId` naming a missing node, is `groupStructureRefusalReason`'s check.
 */
export function groupContractViolations(input: {
  nodes: readonly GroupGraphNode[];
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
    ruleBreaksForMembers({
      groupLabel: nodeLabel(group),
      memberIds: new Set(
        input.nodes
          .filter((node) => node.parentId === group.id)
          .map((node) => node.id)
      ),
      nodes: input.nodes,
      edges: input.edges,
      joins,
      nodeById,
    }).map((ruleBreak) => ({
      groupId: group.id,
      groupLabel: nodeLabel(group),
      ...ruleBreak,
    }))
  );
}
