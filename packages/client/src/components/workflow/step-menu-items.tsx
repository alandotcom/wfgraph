import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Group,
  Maximize2,
  Minimize2,
  Plus,
  SlidersHorizontal,
  Trash2,
  Ungroup,
} from "lucide-react";
import type { ReactNode } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { stepOutlets } from "#src/components/workflow/connection-handle";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import { useAddStepAfter } from "#src/components/workflow/use-add-step";
import {
  collapsedGroupIdsAtom,
  toggleGroupCollapsedAtom,
} from "#src/lib/collapsed-groups";
import { canUngroup } from "#src/lib/node-group";
import { currentPlatform, isApplePlatform } from "#src/lib/shortcut-label";
import {
  copySelectionAtom,
  deleteGroupWithMembersAtom,
  deleteNodeAtom,
  duplicateSelectionAtom,
  edgesAtom,
  groupSelectionAtom,
  nodesAtom,
  selectOnlyNodeAtom,
  ungroupNodeAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { analyzeGroupableSelection } from "@wfgraph/shared/graph/node-group";
import { editFocusTarget } from "./canvas-reveal/reveal-edit-target";
import { requestRevealEditFocusAtom } from "./canvas-reveal/reveal-requests";
import { useRevealNavigation } from "./canvas-reveal/use-reveal-navigation";
import { deleteGroupWithStepsConfirmation } from "./group-delete-confirmation";

/**
 * Where a menu row sits. A menu draws a rule between two rows of different
 * groups, so the rows read as edit, add, arrange and delete.
 */
type StepMenuGroup = "edit" | "add" | "arrange" | "delete";

/** One command a step's menus offer, with everything a menu needs to draw it. */
export type StepMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  group: StepMenuGroup;
  run: () => void;
  shortcut?: string | undefined;
  disabled?: boolean | undefined;
  /** Why the row is disabled, drawn under its label. */
  hint?: string | undefined;
  destructive?: boolean | undefined;
};

/** A chord with this keyboard's modifier, such as ⌘D or Ctrl+D. */
function chord(key: string): string {
  return isApplePlatform(currentPlatform()) ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * The commands for one step, Group or the Lifecycle node, as the canvas's
 * context menu and the Inspector's ⋯ menu both offer them: Edit, Disable or
 * Enable, Add step after on each outlet, Copy, Duplicate, Group, Ungroup,
 * Collapse or Expand a Group, and Delete. `selectedIds` is the selection the
 * Group row would group. Each item only runs its command; the menu closes
 * itself.
 */
export function useStepMenuItems(input: {
  nodeId: string | undefined;
  selectedIds: ReadonlySet<string>;
  /** Whether the person may edit the draft now. */
  canEdit: boolean;
  /** Whether Add step after and Duplicate may insert steps. */
  canInsert: boolean;
}): readonly StepMenuItem[] {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const collapsedGroupIds = useAtomValue(collapsedGroupIdsAtom);
  const catalog = useExtensionCatalog();
  const store = useStore();
  const navigation = useRevealNavigation();
  const { open: openOverlay } = useOverlay();
  const addStepAfter = useAddStepAfter();
  const deleteNode = useSetAtom(deleteNodeAtom);
  const copySelection = useSetAtom(copySelectionAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);
  const groupSelected = useSetAtom(groupSelectionAtom);
  const ungroupSelected = useSetAtom(ungroupNodeAtom);
  const toggleGroupCollapsed = useSetAtom(toggleGroupCollapsedAtom);
  const selectOnlyNode = useSetAtom(selectOnlyNodeAtom);
  const requestEditFocus = useSetAtom(requestRevealEditFocusAtom);
  const deleteGroupWithMembers = useSetAtom(deleteGroupWithMembersAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);

  const node = nodes.find((item) => item.id === input.nodeId);
  if (!(input.canEdit && node)) {
    return [];
  }
  const nodeId = node.id;
  const nodeLabel = node.data.label || "Step";
  const isLifecycle = node.data.type === "lifecycle";
  const isGroup = isGroupNode(node);
  const isDisabled = node.data.enabled === false;
  const grouping = analyzeGroupableSelection({
    nodes,
    edges,
    selectedIds: input.selectedIds,
  });
  const items: StepMenuItem[] = [
    {
      id: "edit",
      label: `Edit ${nodeLabel}`,
      icon: <SlidersHorizontal />,
      group: "edit",
      // Edit opens the Inspector with keyboard focus in the object's label,
      // or in the action picker of a step with no action yet.
      run: () => {
        selectOnlyNode(nodeId);
        navigation.openNode({
          address: store.get(activeWorkspaceAddressAtom),
          nodeId,
        });
        requestEditFocus({ nodeId, targetId: editFocusTarget(node) });
      },
    },
  ];
  // A step switches on and off by itself, inside a Group or outside one. A
  // frame is organization only and has no enabled state of its own.
  if (node.data.type === "action") {
    items.push({
      id: "toggle-enabled",
      label: `${isDisabled ? "Enable" : "Disable"} ${nodeLabel}`,
      icon: isDisabled ? <Eye /> : <EyeOff />,
      group: "edit",
      run: () => updateNodeData({ id: nodeId, data: { enabled: isDisabled } }),
    });
  }
  // One row per outlet, so a Condition or an Event Split says which branch the
  // step goes on. A collapsed Group card uses its existing continuation ports
  // or terminal non-Condition members, leaving unused branches unwired.
  for (const outlet of stepOutlets({ node, nodes, edges, catalog })) {
    items.push({
      id: `add-after-${outlet.handle ?? "only"}`,
      label:
        outlet.label === null
          ? "Add step after"
          : `Add step after ${outlet.label}`,
      icon: <Plus />,
      group: "add",
      disabled: !input.canInsert,
      run: () => addStepAfter({ source: { nodeId, handle: outlet.handle } }),
    });
  }
  items.push(
    {
      id: "copy",
      label: "Copy",
      icon: <Copy />,
      group: "arrange",
      shortcut: chord("C"),
      disabled: isLifecycle,
      run: () => copySelection(nodeId),
    },
    {
      id: "duplicate",
      label: "Duplicate",
      icon: <CopyPlus />,
      group: "arrange",
      shortcut: chord("D"),
      disabled: isLifecycle || !input.canInsert,
      run: () => showGraphEditRefusal(duplicateSelection(nodeId)),
    },
    {
      id: "group",
      label: "Group",
      icon: <Group />,
      group: "arrange",
      shortcut: chord("G"),
      disabled: !grouping.ok,
      hint: grouping.ok ? undefined : grouping.error,
      run: () => groupSelected({ selectedIds: input.selectedIds }),
    }
  );
  if (canUngroup(node)) {
    items.push({
      id: "ungroup",
      label: "Ungroup",
      icon: <Ungroup />,
      group: "arrange",
      run: () => ungroupSelected(nodeId),
    });
  }
  // Collapsing is the viewer's own view, so it needs no edit grant.
  if (isGroup) {
    const collapsed = collapsedGroupIds.has(nodeId);
    items.push({
      id: "toggle-collapsed",
      label: collapsed ? "Expand group" : "Collapse group",
      icon: collapsed ? <Maximize2 /> : <Minimize2 />,
      group: "arrange",
      run: () => toggleGroupCollapsed(nodeId),
    });
  }
  // Ungroup is how a frame alone is removed, so a frame's destructive row is
  // the explicit, confirmed delete of the Group's steps. Deleting a step is one
  // undo step, as it is from the Backspace key, so it happens at once.
  items.push(
    isGroup
      ? {
          id: "delete",
          label: "Delete Group and steps",
          icon: <Trash2 />,
          group: "delete",
          destructive: true,
          run: () =>
            openOverlay(
              ConfirmOverlay,
              deleteGroupWithStepsConfirmation(() =>
                deleteGroupWithMembers(nodeId)
              )
            ),
        }
      : {
          id: "delete",
          label: `Delete ${nodeLabel}`,
          icon: <Trash2 />,
          group: "delete",
          destructive: true,
          disabled: isLifecycle,
          run: () => deleteNode(nodeId),
        }
  );
  return items;
}

/**
 * Whether a menu draws a rule above the item at `index`: where the group
 * changes from the row before it.
 */
export function startsGroup(
  items: readonly StepMenuItem[],
  index: number
): boolean {
  return index > 0 && items[index - 1]?.group !== items[index]?.group;
}
