/**
 * How the server's validation messages name a step, in the words the editor's
 * issue list uses (`stepName`): "Step 2 "Send reminder"", with the number the
 * outline gives the step. A step with no label of its own goes by its action's
 * label, or by its number alone; one with neither goes by what its card is
 * titled. A node id and the word "Node" never appear.
 */

import {
  emptyExtensionCatalog,
  type ExtensionCatalog,
  findAction,
} from "@wfgraph/shared/extensions/catalog";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { stepName, unlabelledStepName } from "@wfgraph/shared/graph/step-name";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { workflowStepNumbers } from "@wfgraph/shared/graph/workflow-outline";

export type StepNames = {
  /** The step's number in the outline, or undefined for a node with none. */
  readonly numberOf: (nodeId: string) => number | undefined;
  /** The step as the subject of a sentence. */
  readonly of: (node: WorkflowNode) => string;
};

/**
 * Names every step of a graph by its outline number. The outline is built on
 * the first name asked for, so a graph that passes every check never builds
 * it. The outline orders steps by the graph alone and reads the catalog only
 * for labels, so the numbers are taken without it; `catalog` supplies the
 * label of a step that has none of its own.
 */
export function stepNames(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog?: ExtensionCatalog | undefined;
}): StepNames {
  let numbers: ReadonlyMap<string, number> | undefined;
  return namesWith(input.catalog ?? emptyExtensionCatalog, (nodeId) => {
    numbers ??= workflowStepNumbers({
      nodes: input.nodes,
      edges: input.edges,
      catalog: emptyExtensionCatalog,
    });
    return numbers.get(nodeId);
  });
}

/** Names steps by their labels alone, for a check that holds no edges. */
export function unnumberedStepNames(
  catalog: ExtensionCatalog = emptyExtensionCatalog
): StepNames {
  return namesWith(catalog, () => undefined);
}

function namesWith(
  catalog: ExtensionCatalog,
  numberOf: (nodeId: string) => number | undefined
): StepNames {
  return {
    numberOf,
    of: (node) => {
      const number = numberOf(node.id);
      const actionType = actionTypeOf(node);
      const label =
        node.data.label?.trim() ||
        (actionType === undefined
          ? undefined
          : (findAction(catalog, actionType)?.label ?? actionType));
      return stepName(
        label ?? (number === undefined ? unlabelledStepName(node) : undefined),
        number
      );
    },
  };
}
