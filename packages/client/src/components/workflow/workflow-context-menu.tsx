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
import { useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useDomEvent } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
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
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { canUngroup, refuseDelete } from "#src/lib/node-group";
import { WORKFLOW_NODE_HEIGHT } from "#src/lib/workflow-node-dimensions";
import { cn } from "@wfgraph/shared/utils";
import { analyzeGroupableSelection } from "@wfgraph/shared/graph/node-group";

export type ContextMenuType = "node" | "edge" | "pane" | null;

/** The widest the menu draws (`max-w-72`), and the gap it keeps from the window
 *  edge. A menu holding no hint is narrower than this, and clamping it as though
 *  it were the widest one only ever leaves it further inside the window. */
const MENU_WIDTH_PX = 288;
const VIEWPORT_MARGIN_PX = 8;
/**
 * The tallest the menu gets: six rows, one of them carrying a wrapped hint.
 * Read to decide which edge the menu hangs from, so a click near the bottom of
 * the window opens upward the way a native context menu does. A measurement
 * would be exact and would also cost a layout pass per open, and the only thing
 * riding on it is which of two anchors is used.
 */
const MENU_HEIGHT_PX = 280;

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
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const copySelection = useSetAtom(copySelectionAtom);
  const pasteSelection = useSetAtom(pasteCopiedSelectionAtom);
  const duplicateSelection = useSetAtom(duplicateSelectionAtom);
  const groupSelected = useSetAtom(groupSelectionAtom);
  const ungroupSelected = useSetAtom(ungroupNodeAtom);
  const hasCopiedSelection = useAtomValue(hasCopiedSelectionAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);
  const catalog = useExtensionCatalog();
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
      // On a narrow canvas no rail is mounted to show the selection, so the
      // sheet is the only surface that can answer this click.
      if (isMobile) {
        openSheet();
      }
    }
  }, [menuState, onClose, setSelectedNode, isMobile, openSheet]);

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

  // Straight to the node types, carrying the spot the user right-clicked:
  // someone who opened this menu on the graph has already said where the step
  // goes, so the palette's root page has nothing left to ask.
  const handleAddStep = useCallback(() => {
    if (menuState?.flowPosition) {
      openPalette({
        id: "add-step",
        at: {
          x: menuState.flowPosition.x,
          y: menuState.flowPosition.y - WORKFLOW_NODE_HEIGHT / 2,
        },
      });
    }
    onClose();
  }, [menuState, openPalette, onClose]);

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
    groupSelected({ catalog, selectedIds: menuState.selectedIds ?? new Set() });
    onClose();
  }, [menuState, groupSelected, catalog, onClose]);

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

  // One lookup for the clicked step; every question below reads it.
  const clicked = menuState.nodeId
    ? nodes.find((n) => n.id === menuState.nodeId)
    : undefined;
  const isLifecycleNode = clicked?.data.type === "lifecycle";
  const groupingIds = menuState.selectedIds ?? new Set<string>();
  const grouping = analyzeGroupableSelection(
    nodes,
    edges,
    groupingIds,
    catalog
  );
  const canGroup = grouping.ok;
  const showUngroup = canUngroup(clicked);
  const deleteRefusal = clicked ? refuseDelete([clicked]) : null;
  // Below the cursor when the menu fits there, above it otherwise.
  const opensUpward =
    menuState.position.y + MENU_HEIGHT_PX + VIEWPORT_MARGIN_PX >
    window.innerHeight;
  const nodeLabel = clicked?.data.label || "Step";

  // Mounted on the body rather than in place: the canvas sits inside a
  // `fixed inset-0 z-0` layer, so a z-index written here is measured against
  // that layer's siblings and the properties panel drew over the menu.
  return createPortal(
    <div
      className="fade-in-0 zoom-in-95 fixed z-50 max-h-[calc(100vh-1rem)] w-fit min-w-[8rem] max-w-72 animate-in overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:animate-none"
      ref={menuRef}
      style={{
        // Held inside the right edge against the widest the menu can draw, so
        // a right-click near that edge no longer puts half the menu off the
        // window. The item hints are what made it wide enough to matter.
        left: `min(${menuState.position.x}px, calc(100vw - ${MENU_WIDTH_PX + VIEWPORT_MARGIN_PX}px))`,
        ...(opensUpward
          ? { bottom: `calc(100vh - ${menuState.position.y}px)` }
          : { top: menuState.position.y }),
        transformOrigin: opensUpward ? "bottom left" : "top left",
      }}
    >
      {menuState.type === "node" && (
        <>
          <MenuItem
            icon={<SlidersHorizontal className="size-4" />}
            label={`Edit ${nodeLabel}`}
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
            disabled={!showUngroup}
            icon={<Ungroup className="size-4" />}
            label="Ungroup"
            onClick={handleUngroup}
          />
          <MenuItem
            disabled={isLifecycleNode || Boolean(deleteRefusal)}
            hint={deleteRefusal ?? undefined}
            icon={<Trash2 className="size-4" />}
            label={`Delete ${nodeLabel}`}
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
    </div>,
    document.body
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
      <span className="shrink-0">{icon}</span>
      {/* The hint wraps rather than widening the menu, and a step named longer
          than the row truncates, since the row is what says which step this is
          and the name is repeated in the properties panel. */}
      <span className="flex min-w-0 flex-col items-start text-left">
        <span className="w-full truncate">{label}</span>
        {hint ? (
          <span className="text-muted-foreground text-xs leading-tight">
            {hint}
          </span>
        ) : null}
      </span>
      {/* A disabled row drops its shortcut: the key does nothing there, and the
          space it held is what the hint wraps into. */}
      {shortcut && !disabled ? (
        <span className="ml-auto shrink-0 pl-4 text-muted-foreground text-xs tracking-widest">
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
