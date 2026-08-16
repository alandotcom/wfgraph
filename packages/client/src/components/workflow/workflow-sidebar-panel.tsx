import { useAtom, useAtomValue } from "jotai";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConfigurationSheet } from "#src/hooks/use-configuration-sheet";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import { useLeaveRunsSurface } from "#src/hooks/use-exit-run";
import { useIsMobile } from "#src/hooks/use-mobile";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  isSidebarCollapsedAtom,
  sidebarWidthCss,
  sidebarWidthPercentAtom,
} from "#src/lib/workflow-ui-store";
import {
  type ConfirmRequest,
  type NodeConfigFrame,
  NodeConfigPanel,
} from "./node-config-panel";

/** Below this much travel a press on the resize edge counts as a click. */
const DRAG_THRESHOLD_PX = 4;

/**
 * The rail's half of the node config panel: it confirms in an AlertDialog, its
 * tabs sit above the content, and it has no `dismiss` because the rail is
 * always on screen.
 */
function NodeConfigRail() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const frame = useMemo<NodeConfigFrame>(
    () => ({ confirm: setRequest, tabs: "top" }),
    []
  );

  return (
    <aside className="flex size-full flex-col overflow-hidden bg-card">
      <NodeConfigPanel frame={frame} />
      <DeleteConfirmDialog
        confirmLabel={request?.confirmLabel}
        description={request?.message}
        // No dismissal in onConfirm: the dialog's action is an AlertDialog.Close,
        // so it is already going away by the time the handler runs.
        onConfirm={() => request?.onConfirm()}
        onOpenChange={(open) => {
          if (!open) {
            setRequest(null);
          }
        }}
        open={request !== null}
        title={request?.title}
      />
    </aside>
  );
}

export function WorkflowSidebarPanel() {
  const isMobile = useIsMobile();
  const [panelCollapsed, setPanelCollapsedState] = useAtom(
    isSidebarCollapsedAtom
  );
  const [panelWidth, setPanelWidth] = useAtom(sidebarWidthPercentAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const { hasOverlays } = useOverlay();
  const { openSheet } = useConfigurationSheet();
  const leaveRunsSurface = useLeaveRunsSurface();

  // Narrowing past the breakpoint unmounts this rail. If it was showing a node,
  // that node's config would vanish with it, so the sheet picks it up. The
  // widening direction is handled in ConfigurationOverlay, which dismisses
  // itself once a rail exists; between them there is exactly one editor on
  // screen at any width.
  useAfterCommit(isMobile, () => {
    if (isMobile && selectedNodeId && !hasOverlays) {
      openSheet();
    }
  });

  /**
   * The single write to the collapsed preference, because collapsing also has to
   * close any open run. Collapsing slides the rail behind the viewport edge
   * rather than unmounting it, so the Runs tab keeps its state while its tab bar
   * is out of reach: the run stayed pinned to the canvas and every edit was
   * refused with nothing on screen saying why (#96 on the sheet, same shape
   * here).
   *
   * Takes the next value rather than an updater, so the exit is decided here and
   * not inside a state write that has no business having side effects.
   */
  const setPanelCollapsed = useCallback(
    (collapsed: boolean) => {
      if (collapsed) {
        leaveRunsSurface();
      }
      setPanelCollapsedState(collapsed);
    },
    [setPanelCollapsedState, leaveRunsSurface]
  );

  const [isDraggingResize, setIsDraggingResize] = useState(false);
  const isResizing = useRef(false);

  const handleToggleShortcut = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setPanelCollapsed(!panelCollapsed);
      }
    },
    [setPanelCollapsed, panelCollapsed]
  );

  useDomEvent(window, "keydown", handleToggleShortcut);

  // Pointer events rather than mouse events, so the strip also answers touch
  // and pen. On a tablet the mouse-only version left the panel unresizable and,
  // with the collapse button hidden behind hover, undismissable.
  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isResizing.current = true;
      setIsDraggingResize(true);

      // A press that never travels is a click, and a click on the edge collapses
      // the panel. Without this the edge is a control that answers only one of
      // the two gestures a user will try on it.
      const startX = e.clientX;
      let travelled = false;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (!isResizing.current) {
          return;
        }
        if (Math.abs(moveEvent.clientX - startX) > DRAG_THRESHOLD_PX) {
          travelled = true;
        }
        if (!travelled) {
          return;
        }
        const newWidth =
          ((window.innerWidth - moveEvent.clientX) / window.innerWidth) * 100;
        setPanelWidth(Math.min(50, Math.max(20, newWidth)));
      };

      const handlePointerUp = () => {
        isResizing.current = false;
        setIsDraggingResize(false);
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", handlePointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (!travelled) {
          setPanelCollapsed(!panelCollapsed);
        }
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [setPanelWidth, setPanelCollapsed, panelCollapsed]
  );

  return (
    <>
      {/* Expand button when panel is collapsed */}
      {!isMobile && panelCollapsed && (
        <button
          className="pointer-events-auto absolute top-1/2 right-0 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded-l-full border border-r-0 bg-background shadow-sm transition-colors hover:bg-muted"
          onClick={() => {
            setPanelCollapsed(false);
          }}
          type="button"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}

      {/* Right panel overlay (desktop only) */}
      {!isMobile && (
        <div
          className="workflow-sidebar-panel pointer-events-auto absolute inset-y-0 right-0 z-20 border-l bg-sidebar transition-transform duration-200 ease-out"
          style={{
            // Same expression the canvas reserves with, from one helper, so the
            // two can never disagree and leave a gap. The Panel tone is what
            // makes this read as a separate plane, which a 1.00:1 fill against
            // the canvas in dark mode was not doing.
            width: sidebarWidthCss(panelWidth),
            transform: panelCollapsed ? "translateX(100%)" : "translateX(0)",
          }}
        >
          {/* Resize handle with collapse button */}
          <div
            aria-label="Resize properties panel. Click to collapse."
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            className="group absolute inset-y-0 left-0 z-10 w-3 cursor-col-resize"
            onPointerDown={handleResizeStart}
            role="separator"
            tabIndex={0}
          >
            {/* Hover indicator */}
            <div className="absolute inset-y-0 left-0 w-1 bg-transparent transition-colors group-hover:bg-ring group-active:bg-primary" />
            {/* Collapse button - hidden while resizing */}
            {!(isDraggingResize || panelCollapsed) && (
              <button
                aria-label="Collapse panel"
                className="absolute top-1/2 left-0 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background shadow-sm transition-opacity hover:bg-muted focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setPanelCollapsed(true);
                }}
                // Must match the event the strip starts a resize on. While this
                // guard was still on mousedown, pointerdown reached the strip,
                // began a drag, and its preventDefault swallowed the click, so
                // the button did nothing at all.
                onPointerDown={(e) => e.stopPropagation()}
                type="button"
              >
                <ChevronRight className="size-4" />
              </button>
            )}
          </div>
          <NodeConfigRail />
        </div>
      )}
    </>
  );
}
