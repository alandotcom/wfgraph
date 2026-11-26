import type { Edge, Node, XYPosition } from "@xyflow/react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { ClipboardPaste, Link2Off, Plus } from "lucide-react";
import { useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { menuClassNames } from "#src/components/ui/dropdown-menu";
import { Kbd } from "#src/components/ui/kbd";
import { useDomEvent } from "#src/hooks/effects";
import {
  deleteEdgeAtom,
  hasCopiedSelectionAtom,
  pasteCopiedSelectionAtom,
} from "#src/lib/workflow-graph-store";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { WORKFLOW_NODE_HEIGHT } from "#src/lib/workflow-node-dimensions";
import { cn } from "@wfgraph/shared/utils";
import { showGraphEditRefusal } from "#src/components/workflow/graph-edit-refusal";
import { useCanvasInteraction } from "#src/components/workflow/canvas-interaction";
import { useInsertStepOnEdge } from "#src/components/workflow/use-add-step";
import {
  chord,
  type StepMenuItem,
  startsGroup,
  useStepMenuItems,
} from "./step-menu-items";

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

/**
 * The open context menu, or null. The canvas and the outline both open it, so
 * a row and its card answer a right-click with the same menu.
 */
export const contextMenuAtom = atom<ContextMenuState>(null);

type WorkflowContextMenuProps = {
  menuState: ContextMenuState;
  onClose: () => void;
};

/**
 * The canvas's context menu for a step, a connection or the empty pane. What
 * it offers follows `useCanvasInteraction`: nothing while the canvas takes no
 * topology edits, and no Add step, Insert step, Paste or Duplicate while it
 * inserts no steps.
 */
export function WorkflowContextMenu({
  menuState,
  onClose,
}: WorkflowContextMenuProps) {
  const interaction = useCanvasInteraction();
  const canEdit = interaction.editsTopology;
  const canInsert = interaction.insertsNodes;
  const deleteEdge = useSetAtom(deleteEdgeAtom);
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const pasteSelection = useSetAtom(pasteCopiedSelectionAtom);
  const hasCopiedSelection = useAtomValue(hasCopiedSelectionAtom);
  const insertStepOnEdge = useInsertStepOnEdge();
  const menuRef = useRef<HTMLDivElement>(null);
  const nodeItems = useStepMenuItems({
    nodeId: menuState?.type === "node" ? menuState.nodeId : undefined,
    selectedIds: menuState?.selectedIds ?? new Set<string>(),
  });

  // Deleting a connection is one undo step, as deleting a step is, so it
  // happens at once with no confirmation.
  const handleDeleteEdge = useCallback(() => {
    if (canEdit && menuState?.edgeId) {
      const edgeId = menuState.edgeId;
      onClose();
      deleteEdge(edgeId);
    }
  }, [canEdit, menuState, deleteEdge, onClose]);

  // Straight to the node types, carrying the spot the user right-clicked:
  // someone who opened this menu on the graph has already said where the step
  // goes, so the palette's root page has nothing left to ask.
  const handleAddStep = useCallback(() => {
    if (canInsert && menuState?.flowPosition) {
      openPalette({
        id: "add-step",
        at: {
          x: menuState.flowPosition.x,
          y: menuState.flowPosition.y - WORKFLOW_NODE_HEIGHT / 2,
        },
      });
    }
    onClose();
  }, [canInsert, menuState, openPalette, onClose]);

  const handleInsertStep = useCallback(() => {
    if (canInsert && menuState?.edgeId) {
      insertStepOnEdge({ edgeId: menuState.edgeId });
    }
    onClose();
  }, [canInsert, insertStepOnEdge, menuState, onClose]);

  const handlePaste = useCallback(() => {
    if (canInsert) {
      showGraphEditRefusal(pasteSelection(menuState?.flowPosition));
    }
    onClose();
  }, [canInsert, menuState, pasteSelection, onClose]);

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

  // Escape closes the menu, and `preventDefault` tells the Inspector, which
  // listens in the document's capture phase, to leave the key alone.
  const handleEscape = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
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
  // On the window in the capture phase, which runs ahead of the Inspector's listener.
  useDomEvent(window, "keydown", handleEscape, {
    capture: true,
    enabled: isMenuOpen,
  });
  // The menu is positioned in viewport coordinates against a node that has since
  // moved, so a resize leaves it pointing at nothing. It also survived the
  // breakpoint change that swaps the canvas layout.
  useDomEvent(window, "resize", onClose, { enabled: isMenuOpen });

  if (!(canEdit && menuState)) {
    return null;
  }

  // Below the cursor when the menu fits there, above it otherwise.
  const opensUpward =
    menuState.position.y + MENU_HEIGHT_PX + VIEWPORT_MARGIN_PX >
    window.innerHeight;

  // Mounted on the body rather than in place: the canvas sits inside a
  // `fixed inset-0 z-0` layer, so a z-index written here is measured against
  // that layer's siblings and the properties panel drew over the menu.
  return createPortal(
    <div
      // Names the menu to the editor's shortcut gate, which holds every editor
      // chord while it is open.
      data-slot="canvas-context-menu"
      className={cn(
        menuClassNames.surface,
        "fade-in-0 zoom-in-95 fixed z-50 max-h-[calc(100vh-1rem)] w-fit min-w-32 max-w-72 animate-in overflow-y-auto duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:animate-none"
      )}
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
      {menuState.type === "node" &&
        nodeItems.map((item, index) => (
          <StepMenuRow
            item={item}
            key={item.id}
            onClose={onClose}
            separated={startsGroup(nodeItems, index)}
          />
        ))}

      {menuState.type === "edge" && (
        <>
          <MenuItem
            disabled={!canInsert}
            icon={<Plus />}
            label="Insert step"
            onClick={handleInsertStep}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Link2Off />}
            label="Delete connection"
            onClick={handleDeleteEdge}
            variant="destructive"
          />
        </>
      )}

      {menuState.type === "pane" && (
        <>
          <MenuItem
            disabled={!canInsert}
            icon={<Plus />}
            label="Add step"
            onClick={handleAddStep}
          />
          <MenuItem
            disabled={!(canInsert && hasCopiedSelection)}
            icon={<ClipboardPaste />}
            label="Paste"
            onClick={handlePaste}
            shortcut={chord("V")}
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
  variant?: "default" | "destructive" | undefined;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  shortcut?: string | undefined;
};

/** One row of a step's commands, with the rule above it that starts its group. */
function StepMenuRow({
  item,
  separated,
  onClose,
}: {
  item: StepMenuItem;
  separated: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {separated ? <MenuSeparator /> : null}
      <MenuItem
        disabled={item.disabled}
        hint={item.disabled ? item.hint : undefined}
        icon={item.icon}
        label={item.label}
        onClick={() => {
          onClose();
          item.run();
        }}
        shortcut={item.shortcut}
        variant={item.destructive ? "destructive" : "default"}
      />
    </>
  );
}

/** The rule between groups of rows, the one the toolbar's menus draw. */
function MenuSeparator() {
  return <div className={menuClassNames.separator} role="separator" />;
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
        menuClassNames.item,
        "w-full",
        "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        variant === "destructive" &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive",
        disabled && "pointer-events-none"
      )}
      disabled={disabled}
      onClick={onClick}
      title={hint}
      type="button"
    >
      {/* A disabled row dims its icon and label and leaves the hint at full
          muted contrast, since the hint is the reason the row is disabled. */}
      <span className={cn("shrink-0", disabled && "opacity-50")}>{icon}</span>
      {/* The hint wraps rather than widening the menu, and a step named longer
          than the row truncates, since the row is what says which step this is
          and the name is repeated in the properties panel. */}
      <span className="flex min-w-0 flex-col items-start text-left">
        <span className={cn("w-full truncate", disabled && "opacity-50")}>
          {label}
        </span>
        {hint ? (
          <span className="text-muted-foreground text-xs leading-tight">
            {hint}
          </span>
        ) : null}
      </span>
      {/* A disabled row drops its shortcut: the key does nothing there, and the
          space it held is what the hint wraps into. */}
      {shortcut && !disabled ? (
        <span className="ml-auto shrink-0 pl-4">
          <Kbd>{shortcut}</Kbd>
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
