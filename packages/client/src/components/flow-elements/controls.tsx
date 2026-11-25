import { useReactFlow, useStore } from "@xyflow/react";
import { useAtom, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import {
  MapPin,
  MapPinXInside,
  Maximize2,
  RefreshCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "#src/components/ui/button";
import { ButtonGroup } from "#src/components/ui/button-group";
import { useIsMobile } from "#src/hooks/use-mobile";
import { ControlTooltip } from "#src/components/ui/control-tooltip";
import {
  currentPlatform,
  editorShortcutLabels,
  isApplePlatform,
} from "#src/lib/shortcut-label";
import { workflowFitViewOptions } from "#src/components/workflow/workflow-viewport";
import { viewportAnimationDuration } from "#src/lib/motion";
import { showMinimapAtom } from "#src/lib/workflow-ui-store";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { workflowZoomPresentation } from "#src/components/workflow/workflow-viewport";

type ControlsProps = {
  onReflow?: (() => void) | undefined;
  canReflow?: boolean | undefined;
  /** What sits above the zoom buttons, such as `OverviewCue`. */
  children?: ReactNode | undefined;
};

/**
 * While the canvas is zoomed out to its overview presentation, a card saying
 * that node details appear when zoomed in, with a way to find a node by name.
 * Renders nothing at detail zoom.
 */
export function OverviewCue() {
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const overview = useStore(
    (state) => workflowZoomPresentation(state.transform[2]) === "overview"
  );
  if (!overview) {
    return null;
  }
  return (
    <div
      className="w-44 rounded-md border bg-card px-2 py-1.5 text-xs shadow-sm"
      data-slot="canvas-overview-cue"
    >
      <p className="font-medium">Overview</p>
      <p className="mt-0.5 text-muted-foreground">Zoom in to view details.</p>
      <Button
        className="mt-1.5 h-11 px-3 md:h-7 md:px-2"
        onClick={() => openPalette({ id: "find-node" })}
        size="xs"
        variant="outline"
      >
        Find a node
      </Button>
    </div>
  );
}

export const Controls = ({
  onReflow,
  canReflow = true,
  children,
}: ControlsProps) => {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const isMobile = useIsMobile();
  const [showMinimap, setShowMinimap] = useAtom(showMinimapAtom);

  const handleZoomIn = () => {
    void zoomIn();
  };

  const handleZoomOut = () => {
    void zoomOut();
  };

  const handleFitView = () => {
    void fitView(workflowFitViewOptions(viewportAnimationDuration()));
  };

  const handleToggleMinimap = () => {
    setShowMinimap(!showMinimap);
  };
  const minimapLabel = showMinimap ? "Hide minimap" : "Show minimap";
  const onApple = isApplePlatform(currentPlatform());
  const shortcuts = editorShortcutLabels(onApple);

  // The group draws on the card surface, because an outline button has no
  // fill of its own and the graph would show through it. A phone lays the
  // buttons in a row along the bottom edge, where a column of 44px targets
  // would cover a third of the canvas's height.
  return (
    <div className="flex flex-col items-start gap-2">
      {children}
      <ButtonGroup
        className="rounded-md bg-card shadow-sm"
        orientation={isMobile ? "horizontal" : "vertical"}
      >
        <ControlTooltip label="Zoom in" side="right">
          <Button
            aria-label="Zoom in"
            className="size-11 md:size-7"
            onClick={handleZoomIn}
            size="icon"
            variant="outline"
          >
            <ZoomIn className="size-4" />
          </Button>
        </ControlTooltip>
        <ControlTooltip label="Zoom out" side="right">
          <Button
            aria-label="Zoom out"
            className="size-11 md:size-7"
            onClick={handleZoomOut}
            size="icon"
            variant="outline"
          >
            <ZoomOut className="size-4" />
          </Button>
        </ControlTooltip>
        <ControlTooltip label="Fit view" shortcut={shortcuts.fitView} side="right">
          <Button
            aria-keyshortcuts={onApple ? "Meta+/" : "Control+/"}
            aria-label="Fit view"
            className="size-11 md:size-7"
            onClick={handleFitView}
            size="icon"
            variant="outline"
          >
            <Maximize2 className="size-4" />
          </Button>
        </ControlTooltip>
        <ControlTooltip label={minimapLabel} side="right">
          <Button
            aria-label={minimapLabel}
            className="size-11 md:size-7"
            onClick={handleToggleMinimap}
            size="icon"
            variant="outline"
          >
            {showMinimap ? (
              <MapPin className="size-4" />
            ) : (
              <MapPinXInside className="size-4" />
            )}
          </Button>
        </ControlTooltip>
        {onReflow ? (
          <ControlTooltip label="Tidy layout" side="right">
            <Button
              aria-label="Tidy layout"
              className="size-11 md:size-7"
              disabled={!canReflow}
              focusableWhenDisabled
              onClick={onReflow}
              size="icon"
              variant="outline"
            >
              <RefreshCcw className="size-4" />
            </Button>
          </ControlTooltip>
        ) : null}
      </ButtonGroup>
    </div>
  );
};
