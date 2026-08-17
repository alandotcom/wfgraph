import type { Edge, Node, XYPosition } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Group,
  Link2Off,
  Plus,
  SlidersHorizontal,
  Trash2,
  Ungroup,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useRef } from "react";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useDomEvent } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  addNodeAtom,
  copySelectionAtom,
  deleteEdgeAtom,
  deleteNodeAtom,
  duplicateSelectionAtom,
  edgesAtom,
  groupSelectionAtom,
  hasCopiedSelectionAtom,
  nodesAtom,
  pasteCopiedSelectionAtom,
  selectedNodeAtom,
  ungroupNodeAtom,
} from "#src/lib/workflow-graph-store";
import { propertiesPanelActiveTabAtom } from "#src/lib/workflow-ui-store";
import { type WorkflowNode } from "#src/lib/workflow-graph-types";
import { WORKFLOW_NODE_HEIGHT } from "#src/components/workflow/workflow-node-dimensions";
import { cn } from "@wfgraph/shared/utils";
import {
  analyzeGroupableSelection,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";

export type ContextMenuType = "node" | "edge" | "pane" | null;

export type ContextMenuState = {
  type: ContextMenuType;
  position: { x: number; y: number };
  flowPosition?: XYPosition;
  nodeId?: string;
  edgeId?: string;
  /** Selection frozen at right-pointer-down, before React Flow collapses it. */
  selectedIds?: ReadonlySet<string>;
} | null;

type WorkflowContextMenuProps = {
  menuState: ContextMenuState;
  onClose: () => void;
};

export function WorkflowContextMenu({
  menuState,
  onClose,
}: WorkflowContextMenuProps) {
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);
  const deleteNode = useSetAtom(deleteNodeAtom);
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const addNode = useSetAtom(addNodeAtom);
  const copySelection = useSetAtom(copySelectionAtom);
  const pasteSelection = useSetAtom(pasteCopiedSelectionAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);
  const groupSelected = useSetAtom(groupSelectionAtom);
  const ungroupSelected = useSetAtom(ungroupNodeAtom);
  const hasCopiedSelection = useAtomValue(hasCopiedSelectionAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const { open: openOverlay } = useOverlay();
  const { openSheet } = useConfigurationSheet();
  const isMobile = useIsMobile();
  const menuRef = useRef<HTMLDivElement>(null);

  const handleDeleteNode = useCallback(() => {
    if (menuState?.nodeId) {
      const nodeId = menuState.nodeId;
      onClose();
      openOverlay(ConfirmOverlay, {
        title: "Delete Step",
        message:
          "Are you sure you want to delete this node? This action cannot be undone.",
        confirmLabel: "Delete",
        confirmVariant: "destructive" as const,
        onConfirm: () => {
          deleteNode(nodeId);
        },
      });
    }
  }, [menuState, deleteNode, onClose, openOverlay]);

  const handleEditNode = useCallback(() => {
    if (menuState?.nodeId) {
      const nodeId = menuState.nodeId;
      onClose();
      setSelectedNode(nodeId);
      setActiveTab("properties");
      // On a narrow canvas no rail is mounted to show the selection, so the
      // sheet is the only surface that can answer this click.
      if (isMobile) {
        openSheet();
      }
    }
  }, [menuState, onClose, setSelectedNode, setActiveTab, isMobile, openSheet]);

  const handleDeleteEdge = useCallback(() => {
    if (menuState?.edgeId) {
      const edgeId = menuState.edgeId;
      onClose();
      openOverlay(ConfirmOverlay, {
        title: "Delete Connection",
        message:
          "Are you sure you want to delete this connection? This action cannot be undone.",
        confirmLabel: "Delete",
        confirmVariant: "destructive" as const,
        onConfirm: () => {
          deleteEdge(edgeId);
        },
      });
    }
  }, [menuState, deleteEdge, onClose, openOverlay]);

  const handleAddStep = useCallback(() => {
    if (menuState?.flowPosition) {
      const newNode: WorkflowNode = {
        id: nanoid(),
        type: "action",
        position: {
          x: menuState.flowPosition.x,
          y: menuState.flowPosition.y - WORKFLOW_NODE_HEIGHT / 2,
        },
        data: {
          label: "",
          description: "",
          type: "action",
          config: {},
          status: "idle",
        },
        selected: true,
      };
      addNode(newNode);
      setSelectedNode(newNode.id);
      setActiveTab("properties");
    }
    onClose();
  }, [menuState, addNode, setSelectedNode, setActiveTab, onClose]);

  const handleCopyNode = useCallback(() => {
    if (menuState?.nodeId) {
      copySelection(menuState.nodeId);
    }
    onClose();
  }, [menuState, copySelection, onClose]);

  const handleDuplicateNode = useCallback(() => {
    if (menuState?.nodeId) {
      duplicateSelection(menuState.nodeId);
    }
    onClose();
  }, [menuState, duplicateSelection, onClose]);

  const handleGroup = useCallback(() => {
    if (menuState?.type !== "node") {
      onClose();
      return;
    }
    groupSelected(menuState.selectedIds ?? new Set());
    onClose();
  }, [menuState, groupSelected, onClose]);

  const handleUngroup = useCallback(() => {
    if (menuState?.nodeId) {
      ungroupSelected(menuState.nodeId);
    }
    onClose();
  }, [menuState, ungroupSelected, onClose]);

  const handlePaste = useCallback(() => {
    pasteSelection(menuState?.flowPosition);
    onClose();
  }, [menuState, pasteSelection, onClose]);

  const handleClickOutside = useCallback(
    (event: MouseEvent) => {
      const target = event.target;
      if (
        menuRef.current &&
        !(target instanceof globalThis.Node && menuRef.current.contains(target))
      ) {
        onClose();
      }
    },
    [onClose]
  );

  const handleEscape = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    },
    [onClose]
  );

  // deferAttach because the right-click that opened this menu is still being
  // dispatched while React commits, so a listener attached now would count it
  // as a click outside and close the menu before it is ever seen.
  const isMenuOpen = menuState !== null;
  useDomEvent(document, "mousedown", handleClickOutside, {
    deferAttach: true,
    enabled: isMenuOpen,
  });
  useDomEvent(document, "keydown", handleEscape, { enabled: isMenuOpen });
  // The menu is positioned in viewport coordinates against a node that has since
  // moved, so a resize leaves it pointing at nothing. It also survived the
  // breakpoint change that swaps the canvas layout.
  useDomEvent(window, "resize", onClose, { enabled: isMenuOpen });

  if (!menuState) {
    return null;
  }

  const isLifecycleNode = Boolean(
    menuState.nodeId &&
    nodes.find((n) => n.id === menuState.nodeId)?.data.type === "lifecycle"
  );

  const clicked = menuState.nodeId
    ? nodes.find((n) => n.id === menuState.nodeId)
    : undefined;
  const groupingIds = menuState.selectedIds ?? new Set<string>();
  const grouping = analyzeGroupableSelection(nodes, edges, groupingIds);
  const canGroup = grouping.ok;
  const canUngroup = Boolean(
    clicked && (isGroupNode(clicked) || clicked.parentId)
  );

  const getNodeLabel = () => {
    if (!menuState.nodeId) {
      return "Step";
    }
    const node = nodes.find((n) => n.id === menuState.nodeId);
    return node?.data.label || "Step";
  };

  return (
    <div
      className="fade-in-0 zoom-in-95 fixed z-50 min-w-[8rem] animate-in overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      ref={menuRef}
      style={{
        left: menuState.position.x,
        top: menuState.position.y,
      }}
    >
      {menuState.type === "node" && (
        <>
          <MenuItem
            icon={<SlidersHorizontal className="size-4" />}
            label={`Edit ${getNodeLabel()}`}
            onClick={handleEditNode}
          />
          <MenuItem
            disabled={isLifecycleNode}
            icon={<Copy className="size-4" />}
            label="Copy"
            onClick={handleCopyNode}
            shortcut={shortcutLabel("C")}
          />
          <MenuItem
            disabled={isLifecycleNode}
            icon={<CopyPlus className="size-4" />}
            label="Duplicate"
            onClick={handleDuplicateNode}
            shortcut={shortcutLabel("D")}
          />
          <MenuItem
            disabled={!canGroup}
            hint={!canGroup && !grouping.ok ? grouping.error : undefined}
            icon={<Group className="size-4" />}
            label="Group"
            onClick={handleGroup}
            shortcut={shortcutLabel("G")}
          />
          <MenuItem
            disabled={!canUngroup}
            icon={<Ungroup className="size-4" />}
            label="Ungroup"
            onClick={handleUngroup}
          />
          <MenuItem
            disabled={isLifecycleNode}
            icon={<Trash2 className="size-4" />}
            label={`Delete ${getNodeLabel()}`}
            onClick={handleDeleteNode}
            variant="destructive"
          />
        </>
      )}

      {menuState.type === "edge" && (
        <MenuItem
          icon={<Link2Off className="size-4" />}
          label="Delete Connection"
          onClick={handleDeleteEdge}
          variant="destructive"
        />
      )}

      {menuState.type === "pane" && (
        <>
          <MenuItem
            icon={<Plus className="size-4" />}
            label="Add Step"
            onClick={handleAddStep}
          />
          <MenuItem
            disabled={!hasCopiedSelection}
            icon={<ClipboardPaste className="size-4" />}
            label="Paste"
            onClick={handlePaste}
            shortcut={shortcutLabel("V")}
          />
        </>
      )}
    </div>
  );
}

type MenuItemProps = {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
  hint?: string;
  shortcut?: string;
};

function shortcutLabel(key: string): string {
  const apple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  return apple ? `⌘${key}` : `Ctrl+${key}`;
}

function MenuItem({
  icon,
  label,
  onClick,
  variant = "default",
  disabled,
  hint,
  shortcut,
}: MenuItemProps) {
  return (
    <button
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
        "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        variant === "destructive" &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive",
        disabled && "pointer-events-none opacity-50"
      )}
      disabled={disabled}
      onClick={onClick}
      title={hint}
      type="button"
    >
      {icon}
      <span className="flex min-w-0 flex-col items-start">
        {label}
        {hint ? (
          <span className="text-muted-foreground text-xs leading-tight">
            {hint}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <span className="ml-auto pl-4 text-muted-foreground text-xs tracking-widest">
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}

export function useContextMenuHandlers(
  screenToFlowPosition: (position: { x: number; y: number }) => XYPosition,
  setMenuState: (state: ContextMenuState) => void,
  selectedIdsAtRightClick: () => ReadonlySet<string>
) {
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      setMenuState({
        type: "node",
        position: { x: event.clientX, y: event.clientY },
        nodeId: node.id,
        selectedIds: selectedIdsAtRightClick(),
      });
    },
    [selectedIdsAtRightClick, setMenuState]
  );

  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      setMenuState({
        type: "edge",
        position: { x: event.clientX, y: event.clientY },
        edgeId: edge.id,
      });
    },
    [setMenuState]
  );

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      const flowPosition = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setMenuState({
        type: "pane",
        position: { x: event.clientX, y: event.clientY },
        flowPosition,
      });
    },
    [screenToFlowPosition, setMenuState]
  );

  return {
    onNodeContextMenu,
    onEdgeContextMenu,
    onPaneContextMenu,
  };
}
