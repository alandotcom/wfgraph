import { useAtom } from "jotai";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useDomEvent } from "@/hooks/effects";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  isSidebarCollapsedAtom,
  sidebarWidthPercentAtom,
} from "@/lib/workflow-ui-store";
import { NodeConfigPanel } from "./node-config-panel";

export function WorkflowSidebarPanel() {
  const isMobile = useIsMobile();
  const [panelCollapsed, setPanelCollapsed] = useAtom(isSidebarCollapsedAtom);
  const [panelWidth, setPanelWidth] = useAtom(sidebarWidthPercentAtom);

  const [isDraggingResize, setIsDraggingResize] = useState(false);
  const isResizing = useRef(false);

  const handleToggleShortcut = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setPanelCollapsed((previous) => !previous);
      }
    },
    [setPanelCollapsed]
  );

  useDomEvent(window, "keydown", handleToggleShortcut);

  // Handle panel resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      setIsDraggingResize(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) {
          return;
        }
        const newWidth =
          ((window.innerWidth - moveEvent.clientX) / window.innerWidth) * 100;
        // Clamp between 20% and 50%
        setPanelWidth(Math.min(50, Math.max(20, newWidth)));
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        setIsDraggingResize(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [setPanelWidth]
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
          className="pointer-events-auto absolute inset-y-0 right-0 z-20 border-l bg-background transition-transform duration-300 ease-out"
          style={{
            width: `${panelWidth}%`,
            transform: panelCollapsed ? "translateX(100%)" : "translateX(0)",
          }}
        >
          {/* Resize handle with collapse button */}
          <div
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            className="group absolute inset-y-0 left-0 z-10 w-3 cursor-col-resize"
            onMouseDown={handleResizeStart}
            role="separator"
            tabIndex={0}
          >
            {/* Hover indicator */}
            <div className="absolute inset-y-0 left-0 w-1 bg-transparent transition-colors group-hover:bg-blue-500 group-active:bg-blue-600" />
            {/* Collapse button - hidden while resizing */}
            {!(isDraggingResize || panelCollapsed) && (
              <button
                className="absolute top-1/2 left-0 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setPanelCollapsed(true);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                type="button"
              >
                <ChevronRight className="size-4" />
              </button>
            )}
          </div>
          <NodeConfigPanel />
        </div>
      )}

      {/* Mobile: NodeConfigPanel renders the overlay trigger button */}
      {isMobile && <NodeConfigPanel />}
    </>
  );
}
