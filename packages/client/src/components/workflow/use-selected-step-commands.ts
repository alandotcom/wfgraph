import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  ArrowDown,
  ArrowUp,
  CopyPlus,
  Eye,
  EyeOff,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { stepOutlets } from "#src/components/workflow/connection-handle";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import { useAddStepAfter } from "#src/components/workflow/use-add-step";
import type { PaletteMenuCommand } from "#src/hooks/use-app-commands";
import { useIsMobile } from "#src/hooks/use-mobile";
import { can } from "#src/lib/authorization";
import { currentPlatform, isApplePlatform } from "#src/lib/shortcut-label";
import {
  canvasEditingLockedAtom,
  deleteNodeAtom,
  duplicateSelectionAtom,
  edgesAtom,
  moveStepAtom,
  nodesAtom,
  selectOnlyNodeAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { editFocusTarget } from "./canvas-reveal/reveal-edit-target";
import { requestRevealEditFocusAtom } from "./canvas-reveal/reveal-requests";
import { useRevealNavigation } from "./canvas-reveal/use-reveal-navigation";
import { selectedStepName, useSelectedStep } from "./use-selected-step";

/** The commands the palette lists for the selected step, and what to call them. */
export type SelectedStepCommands = {
  /** The step as the group's heading reads: "Step 4 · Send 24-hour reminder". */
  title: string;
  commands: readonly PaletteMenuCommand[];
};

/**
 * The commands the selected step's context menu and details column offer, for
 * the command palette, each named with the step: Edit, Disable or Enable,
 * Duplicate, Delete, Add step after it on each outlet, and Move up and down
 * its sequence. Null with no step selected, outside Draft, and for a person
 * who may not edit the workflow or while the draft is locked. A phone, which
 * offers no topology authoring, gets Edit and Disable or Enable alone.
 */
export function useSelectedStepCommands(): SelectedStepCommands | null {
  const step = useSelectedStep();
  const store = useStore();
  const address = useAtomValue(activeWorkspaceAddressAtom);
  const locked = useAtomValue(canvasEditingLockedAtom);
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const catalog = useExtensionCatalog();
  const isMobile = useIsMobile();
  const navigation = useRevealNavigation();
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const requestEditFocus = useSetAtom(requestRevealEditFocusAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const moveStep = useSetAtom(moveStepAtom);
  const addStepAfter = useAddStepAfter();

  if (
    step === null ||
    address.key.workspace !== "draft" ||
    locked ||
    !can(WfGraphOperations.workflowUpdate.id)
  ) {
    return null;
  }
  const { node } = step;
  const onApple = isApplePlatform(currentPlatform());
  const name = selectedStepName(step);
  const isLifecycle = node.data.type === "lifecycle";
  const isAction = node.data.type === "action";
  const isDisabled = node.data.enabled === false;
  const keywords = `${step.label} step selected`;

  const commands: PaletteMenuCommand[] = [
    {
      id: "step-edit",
      label: `Edit ${name}`,
      keywords: `Edit open configure ${keywords}`,
      disabled: false,
      Icon: SlidersHorizontal,
      execute: () => {
        selectOnlyNode(node.id);
        navigation.openNode({
          address: store.get(activeWorkspaceAddressAtom),
          nodeId: node.id,
        });
        requestEditFocus({ nodeId: node.id, targetId: editFocusTarget(node) });
      },
    },
  ];
  if (isAction) {
    commands.push({
      id: "step-toggle-enabled",
      label: `${isDisabled ? "Enable" : "Disable"} ${name}`,
      keywords: `Disable Enable turn off on skip ${keywords}`,
      disabled: false,
      Icon: isDisabled ? Eye : EyeOff,
      execute: () =>
        updateNodeData({ id: node.id, data: { enabled: isDisabled } }),
    });
  }
  if (isMobile || isLifecycle) {
    return { title: capitalized(name), commands };
  }
  for (const outlet of stepOutlets({ node, nodes, edges, catalog })) {
    commands.push({
      id: `step-add-after-${outlet.handle ?? "only"}`,
      label:
        outlet.label === null
          ? `Add a step after ${name}`
          : `Add a step after ${name}, ${outlet.label}`,
      keywords: `Add insert new step after next ${keywords}`,
      disabled: false,
      Icon: Plus,
      execute: () =>
        addStepAfter({ source: { nodeId: node.id, handle: outlet.handle } }),
    });
  }
  if (!isGroupNode(node)) {
    commands.push(
      {
        id: "step-move-up",
        label: `Move ${name} up`,
        keywords: `Move up earlier reorder ${keywords}`,
        hint: onApple ? "⌥↑" : "Alt+Up",
        disabled: false,
        Icon: ArrowUp,
        execute: () =>
          showGraphEditRefusal(moveStep({ nodeId: node.id, direction: "up" })),
      },
      {
        id: "step-move-down",
        label: `Move ${name} down`,
        keywords: `Move down later reorder ${keywords}`,
        hint: onApple ? "⌥↓" : "Alt+Down",
        disabled: false,
        Icon: ArrowDown,
        execute: () =>
          showGraphEditRefusal(
            moveStep({ nodeId: node.id, direction: "down" })
          ),
      },
      {
        id: "step-duplicate",
        label: `Duplicate ${name}`,
        keywords: `Duplicate copy clone ${keywords}`,
        disabled: false,
        Icon: CopyPlus,
        execute: () => showGraphEditRefusal(duplicateSelection(node.id)),
      },
      {
        id: "step-delete",
        label: `Delete ${name}`,
        keywords: `Delete remove ${keywords}`,
        disabled: false,
        Icon: Trash2,
        execute: () => deleteNode(node.id),
      }
    );
  }
  return { title: capitalized(name), commands };
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
