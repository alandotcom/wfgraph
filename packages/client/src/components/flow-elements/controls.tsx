import { useReactFlow } from "@xyflow/react";
import { useAtom } from "jotai";
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

/** The side of one control button at `md` and wider, `md:size-7`, in pixels. */
const DESKTOP_BUTTON_PX = 28;

/**
 * The most buttons the column holds: zoom in, zoom out, fit view, the minimap
 * toggle and Tidy layout.
 */
const MOST_BUTTONS = 5;

/** React Flow's margin between a `Panel` and the canvas edge, in pixels. */
const PANEL_MARGIN_PX = 15;

/** The gap an element floating over the canvas keeps from the controls. */
const CLEARANCE_GAP_PX = 20;

/**
 * The room the controls take in the canvas's bottom-left corner at `md` and
 * wider, with the gap an element floating over the canvas keeps from them, in
 * pixels: `height` above the bottom edge, which the floating outline ends
 * short of, and `width` from the left edge, which the agent's box starts past.
 */
export const DESKTOP_CONTROLS_CLEARANCE_PX = {
  width: PANEL_MARGIN_PX + DESKTOP_BUTTON_PX + CLEARANCE_GAP_PX,
  height: PANEL_MARGIN_PX + MOST_BUTTONS * DESKTOP_BUTTON_PX + CLEARANCE_GAP_PX,
} as const;

type ControlsProps = {
  onReflow?: (() => void) | undefined;
  canReflow?: boolean | undefined;
};

export const Controls = ({ onReflow, canReflow = true }: ControlsProps) => {
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
