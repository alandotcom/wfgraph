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
    <aside {...stylex.props(styles.rail)}>
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
        <IconButton
          icon={<Icon icon={ChevronLeft} size="sm" />}
          label="Expand properties panel"
          onClick={() => {
            setPanelCollapsed(false);
          }}
          size="sm"
          variant="secondary"
          xstyle={styles.expandButton}
        />
      )}

      {/* Right panel overlay (desktop only) */}
      {!isMobile && (
        <div
          style={{
            // Same expression the canvas reserves with, from one helper, so the
            // two can never disagree and leave a gap. The Panel tone is what
            // makes this read as a separate plane, which a 1.00:1 fill against
            // the canvas in dark mode was not doing.
            width: sidebarWidthCss(panelWidth),
            transform: panelCollapsed ? "translateX(100%)" : "translateX(0)",
          }}
          {...stylex.props(styles.panelFrame)}
        >
          {/* Resize handle with collapse button */}
          <div
            aria-label="Resize properties panel. Click to collapse."
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setPanelCollapsed(true);
              }
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setPanelWidth(Math.min(50, panelWidth + 1));
              }
              if (event.key === "ArrowRight") {
                event.preventDefault();
                setPanelWidth(Math.max(20, panelWidth - 1));
              }
            }}
            onPointerDown={handleResizeStart}
            role="separator"
            tabIndex={0}
            {...stylex.props(styles.resizeHandle)}
          >
            <div {...stylex.props(styles.resizeIndicator)} />
            {/* Collapse button - hidden while resizing */}
            {!(isDraggingResize || panelCollapsed) && (
              <IconButton
                icon={<Icon icon={ChevronRight} size="sm" />}
                label="Collapse panel"
                onClick={(e) => {
                  e.stopPropagation();
                  setPanelCollapsed(true);
                }}
                // Must match the event the strip starts a resize on. While this
                // guard was still on mousedown, pointerdown reached the strip,
                // began a drag, and its preventDefault swallowed the click, so
                // the button did nothing at all.
                onPointerDown={(e) => e.stopPropagation()}
                size="sm"
                variant="secondary"
                xstyle={styles.collapseButton}
              />
            )}
          </div>
          <NodeConfigRail />
        </div>
      )}
    </>
  );
}

const styles = stylex.create({
  rail: {
    backgroundColor: colorVars["--color-background-card"],
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
    width: "100%",
  },
  panelFrame: {
    backgroundColor: colorVars["--color-background-card"],
    borderLeftColor: colorVars["--color-border"],
    borderLeftStyle: "solid",
    borderLeftWidth: 1,
    bottom: 0,
    pointerEvents: "auto",
    position: "absolute",
    right: 0,
    top: 0,
    transitionDuration: "200ms",
    transitionProperty: "transform",
    transitionTimingFunction: "ease-out",
    zIndex: 20,
  },
  expandButton: {
    borderBottomRightRadius: 0,
    borderTopRightRadius: 0,
    boxShadow: shadowVars["--shadow-low"],
    pointerEvents: "auto",
    position: "absolute",
    right: 0,
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 20,
  },
  resizeHandle: {
    bottom: 0,
    cursor: "col-resize",
    left: 0,
    position: "absolute",
    top: 0,
    width: 12,
    zIndex: 10,
  },
  resizeIndicator: {
    backgroundColor: colorVars["--color-border"],
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
    width: 1,
  },
  collapseButton: {
    boxShadow: shadowVars["--shadow-low"],
    left: 0,
    position: "absolute",
    top: "50%",
    transform: "translate(-50%, -50%)",
  },
});
import * as stylex from "@stylexjs/stylex";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { colorVars, shadowVars } from "@astryxdesign/core/theme/tokens.stylex";
