import { startNodeTitle } from "@wfgraph/shared/graph/node-display";
import { useAtomValue } from "jotai";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { stepNumbersAtom } from "#src/lib/step-numbers";
import { presentedGraphAtom } from "#src/lib/workflow-graph-presentation-store";
import { groupLabel, type WorkflowNode } from "#src/lib/workflow-graph-types";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import {
  ACTION_TYPE_CONFIG_KEY,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import { isBlank } from "@wfgraph/shared/types/string";

/**
 * The one step the selection holds alone: its node, its number in the outline
 * when it has one, and the label a person reads for it, which falls back to
 * its action's name, the start's title (`startNodeTitle`), or the Group's
 * default name when the label is blank.
 */
export type SelectedStep = {
  node: WorkflowNode;
  number: number | undefined;
  label: string;
};

/** The selected step, or null when the selection holds anything else. */
export function useSelectedStep(): SelectedStep | null {
  const selection = useAtomValue(activeSelectionAtom);
  const nodes = useAtomValue(presentedGraphAtom)?.nodes;
  const numbers = useAtomValue(stepNumbersAtom);
  const catalog = useExtensionCatalog();
  const [nodeId] = selection.nodeIds;
  if (selection.nodeIds.length !== 1 || selection.edgeIds.length > 0) {
    return null;
  }
  const node = nodes?.find((item) => item.id === nodeId);
  if (!node) {
    return null;
  }
  const actionType = readConfigString(node.data.config, ACTION_TYPE_CONFIG_KEY);
  const fallback =
    node.data.type === "lifecycle"
      ? startNodeTitle(catalog, node.data)
      : node.data.type === "group"
        ? groupLabel(node.data.label)
        : ((actionType && findAction(catalog, actionType)?.label) ??
          "Untitled step");
  return {
    node,
    number: numbers.get(node.id),
    label: isBlank(node.data.label) ? fallback : node.data.label,
  };
}

/**
 * A step named as a person refers to it in running text: "step 4 · Send
 * 24-hour reminder", or its label alone when it has no number.
 */
export function selectedStepName(step: {
  number: number | undefined;
  label: string;
}): string {
  return step.number === undefined
    ? step.label
    : `step ${step.number} · ${step.label}`;
}
