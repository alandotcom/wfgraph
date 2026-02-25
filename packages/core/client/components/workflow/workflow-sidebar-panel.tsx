import { useAtom, useSetAtom } from "jotai";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  hasSidebarBeenShownAtom,
  isPanelAnimatingAtom,
  isSidebarCollapsedAtom,
  rightPanelWidthAtom,
} from "@/lib/workflow-store";
import { NodeConfigPanel } from "./node-config-panel";

type WorkflowSidebarPanelProps = {
  enableEntryAnimation?: boolean;
};

function readInitialSidebarWidth() {
  if (typeof document === "undefined") {
    return 30;
  }

  const widthCookie = document.cookie
    .split("; ")
    .find((row) => row.startsWith("sidebar-width="));
  if (!widthCookie) {
    return 30;
  }

  const value = Number.parseFloat(widthCookie.split("=")[1]);
  return !Number.isNaN(value) && value >= 20 && value <= 50 ? value : 30;
}

export function WorkflowSidebarPanel({
  enableEntryAnimation = false,
}: WorkflowSidebarPanelProps) {
  const isMobile = useIsMobile();
  const setRightPanelWidth = useSetAtom(rightPanelWidthAtom);
  const setIsPanelAnimating = useSetAtom(isPanelAnimatingAtom);
  const [hasSidebarBeenShown, setHasSidebarBeenShown] = useAtom(
    hasSidebarBeenShownAtom
  );
  const [panelCollapsed, setPanelCollapsed] = useAtom(isSidebarCollapsedAtom);

  // Panel width state for resizing
  const [panelWidth, setPanelWidth] = useState(readInitialSidebarWidth);
  // Keep the panel visible by default; the animation effect can temporarily hide it.
  const [panelVisible, setPanelVisible] = useState(true);
  const [isDraggingResize, setIsDraggingResize] = useState(false);
  const isResizing = useRef(false);
  const hasReadCookies = useRef(false);

  // Read sidebar preferences from cookies on mount (after hydration)
  useEffect(() => {
    if (hasReadCookies.current) {
      return;
    }
    hasReadCookies.current = true;

    // Read collapsed state
    const collapsedCookie = document.cookie
      .split("; ")
      .find((row) => row.startsWith("sidebar-collapsed="));
    if (collapsedCookie) {
      setPanelCollapsed(collapsedCookie.split("=")[1] === "true");
    }
  }, [setPanelCollapsed]);

  // Save sidebar width to cookie when it changes (skip initial render)
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (!hasInitialized.current) {
      hasInitialized.current = true;
      return;
    }
    // biome-ignore lint/suspicious/noDocumentCookie: simple cookie storage for sidebar width
    document.cookie = `sidebar-width=${panelWidth}; path=/; max-age=31536000`; // 1 year
  }, [panelWidth]);

  // Save collapsed state to cookie when it changes
  useEffect(() => {
    if (!hasReadCookies.current) {
      return;
    }
    // biome-ignore lint/suspicious/noDocumentCookie: simple cookie storage for sidebar state
    document.cookie = `sidebar-collapsed=${panelCollapsed}; path=/; max-age=31536000`; // 1 year
  }, [panelCollapsed]);

  // Trigger slide-in animation on mount (only for homepage -> workflow transition)
  useEffect(() => {
    if (!enableEntryAnimation) {
      return;
    }

    let shouldAnimate = false;
    try {
      // Check if we came from homepage
      shouldAnimate = sessionStorage.getItem("animate-sidebar") === "true";
      sessionStorage.removeItem("animate-sidebar");
    } catch {
      // If sessionStorage is unavailable, skip animation and show panel.
      shouldAnimate = false;
    }

    // Skip animation if sidebar has already been shown (switching between workflows)
    // or if we didn't come from homepage (direct load, refresh)
    if (hasSidebarBeenShown || !shouldAnimate) {
      const readyTimer = setTimeout(() => {
        setPanelVisible(true);
        setHasSidebarBeenShown(true);
      }, 0);
      return () => clearTimeout(readyTimer);
    }

    // Set animating state before starting
    setIsPanelAnimating(true);
    // Delay to ensure the canvas is visible at full width first
    const timer = setTimeout(() => {
      setPanelVisible(true);
      setHasSidebarBeenShown(true);
    }, 100);
    // Clear animating state after animation completes (300ms + buffer)
    const animationTimer = setTimeout(() => setIsPanelAnimating(false), 400);
    return () => {
      clearTimeout(timer);
      clearTimeout(animationTimer);
      setIsPanelAnimating(false);
    };
  }, [
    enableEntryAnimation,
    hasSidebarBeenShown,
    setHasSidebarBeenShown,
    setIsPanelAnimating,
  ]);

  // Fail-safe: ensure the panel is visible on desktop even if animation state gets stuck.
  useEffect(() => {
    if (isMobile || panelVisible) {
      return;
    }
    const timer = setTimeout(() => setPanelVisible(true), 500);
    return () => clearTimeout(timer);
  }, [isMobile, panelVisible]);

  // Keyboard shortcut Cmd/Ctrl+B to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setIsPanelAnimating(true);
        setPanelCollapsed((prev) => !prev);
        setTimeout(() => setIsPanelAnimating(false), 350);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setIsPanelAnimating, setPanelCollapsed]);

  // Set right panel width for AI prompt positioning
  // Only set it after the panel is visible (animated in) to coordinate the animation
  useEffect(() => {
    if (!isMobile && panelVisible && !panelCollapsed) {
      setRightPanelWidth(`${panelWidth}%`);
    } else {
      // During initial render or when collapsed, set to null so prompt is centered
      setRightPanelWidth(null);
    }
  }, [isMobile, setRightPanelWidth, panelWidth, panelVisible, panelCollapsed]);

  // Only clear on unmount; clearing in the effect cleanup causes resize thrash
  // during normal updates (panel width/visibility changes).
  useEffect(
    () => () => {
      setRightPanelWidth(null);
    },
    [setRightPanelWidth]
  );

  // Handle panel resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
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
  }, []);

  return (
    <>
      {/* Expand button when panel is collapsed */}
      {!isMobile && panelCollapsed && (
        <button
          className="pointer-events-auto absolute top-1/2 right-0 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded-l-full border border-r-0 bg-background shadow-sm transition-colors hover:bg-muted"
          onClick={() => {
            setIsPanelAnimating(true);
            setPanelCollapsed(false);
            setTimeout(() => setIsPanelAnimating(false), 350);
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
            transform:
              panelVisible && !panelCollapsed
                ? "translateX(0)"
                : "translateX(100%)",
          }}
        >
          {/* Resize handle with collapse button */}
          {/* biome-ignore lint/a11y/useSemanticElements: custom resize handle */}
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
                  setIsPanelAnimating(true);
                  setPanelCollapsed(true);
                  setTimeout(() => setIsPanelAnimating(false), 350);
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
