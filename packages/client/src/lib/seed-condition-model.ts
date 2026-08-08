import { getUpstreamConditionFields } from "#src/lib/upstream-node-fields";
import {
  compileConditionModel,
  createDefaultConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * The starting condition for a node that has just become a Condition step.
 *
 * A Condition node with no stored model is rejected by
 * `workflow-conditions-validation.ts` when the workflow runs, so a node the
 * user has only dropped on the canvas has to arrive with one. This belongs to
 * the moment the action is chosen, which is what creates the absence, rather
 * than an effect in the builder row noticing it after the fact.
 *
 * Returns nothing when there is no upstream field to build a condition from,
 * because there is then nothing to seed it with.
 */
export function seedConditionModel(input: {
  nodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  catalog: ExtensionCatalog;
}): { conditionModel: string; condition: string } | undefined {
  const [firstField] = getUpstreamConditionFields({
    currentNodeId: input.nodeId,
    nodes: input.nodes,
    edges: input.edges,
    catalog: input.catalog,
  });

  if (!firstField) {
    return undefined;
  }

  const model = createDefaultConditionModel(firstField);
  const compiled = compileConditionModel(model);

  // The model and the CEL string it compiles to are one fact about the node, so
  // they are written together.
  return {
    conditionModel: serializeConditionModel(model),
    condition: compiled.valid ? compiled.expression : "",
  };
}
