/**
 * What Canvas Reveal says about a Condition node, as pure functions: its rules
 * read back as a model, the logic joining them as one sentence, and the steps
 * each of its True and False outlets leads to.
 */

import { partition } from "es-toolkit/array";
import { normalizeConditionBranch } from "@wfgraph/shared/conditions/condition-branch";
import {
  type ConditionModel,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import type { ConditionBranch } from "@wfgraph/shared/graph/types";
import { isBlank } from "@wfgraph/shared/types/string";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * The stored rules of a Condition's config: `empty` when no model is stored,
 * `unreadable` when the stored model does not decode, and otherwise the model,
 * which holds at least one group.
 */
export type StoredConditionRules =
  | { kind: "empty" }
  | { kind: "unreadable" }
  | { kind: "model"; model: ConditionModel };

export function readStoredConditionRules(
  config: Record<string, unknown> | undefined
): StoredConditionRules {
  const stored = readConfigString(config, "conditionModel") ?? "";
  if (isBlank(stored)) {
    return { kind: "empty" };
  }
  const parsed = parseConditionModel(stored);
  return parsed.valid
    ? { kind: "model", model: parsed.model }
    : { kind: "unreadable" };
}

/**
 * One sentence naming when the Condition takes True. Inside one group the
 * group's own AND or OR joins its rules; across groups the model's logic joins
 * the groups.
 */
export function conditionLogicSentence(model: ConditionModel): string {
  const [onlyGroup] = model.groups;
  if (model.groups.length === 1 && onlyGroup) {
    const count = onlyGroup.conditions.length;
    if (count === 1) {
      return "True when the rule matches, and False otherwise.";
    }
    return onlyGroup.logic === "and"
      ? `True when each of the ${count} rules matches, and False otherwise.`
      : `True when any of the ${count} rules matches, and False otherwise.`;
  }
  const count = model.groups.length;
  return model.groupLogic === "and"
    ? `True when each of the ${count} groups matches, and False otherwise.`
    : `True when any of the ${count} groups matches, and False otherwise.`;
}

/** A step one Condition outlet leads to, through the edge `edgeId`. */
export type ConditionBranchTarget = {
  edgeId: string;
  nodeId: string;
  label: string;
};

/**
 * The steps each outlet of the Condition `nodeId` connects to, in edge order.
 * An outlet with nothing connected has an empty list.
 */
export function conditionBranchTargets(input: {
  nodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): Record<ConditionBranch, ConditionBranchTarget[]> {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const links = input.edges.flatMap((edge) => {
    const branch =
      edge.source === input.nodeId
        ? normalizeConditionBranch(edge.sourceHandle)
        : null;
    const target = nodesById.get(edge.target);
    return branch && target
      ? [
          {
            branch,
            target: {
              edgeId: edge.id,
              nodeId: target.id,
              label: getNodeDisplayName(input.catalog, target),
            },
          },
        ]
      : [];
  });
  const [onTrue, onFalse] = partition(links, (link) => link.branch === "true");
  return {
    true: onTrue.map((link) => link.target),
    false: onFalse.map((link) => link.target),
  };
}
