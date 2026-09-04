import { useReactFlow, useStore } from "@xyflow/react";
import { useAtom, useSetAtom } from "jotai";
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
import { workflowFitViewOptions } from "#src/components/workflow/workflow-viewport";
import { viewportAnimationDuration } from "#src/lib/motion";
import { showMinimapAtom } from "#src/lib/workflow-ui-store";
import { openCommandPaletteAtom } from "#src/lib/command-palette-store";
import { workflowZoomPresentation } from "#src/components/workflow/workflow-viewport";

type ControlsProps = {
  onReflow?: (() => void) | undefined;
  canReflow?: boolean | undefined;
};

export const Controls = ({ onReflow, canReflow = true }: ControlsProps) => {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [showMinimap, setShowMinimap] = useAtom(showMinimapAtom);
  const openPalette = useSetAtom(openCommandPaletteAtom);
  const overview = useStore(
    (state) => workflowZoomPresentation(state.transform[2]) === "overview"
  );

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

  return (
    <div className="flex flex-col items-start gap-2">
      {overview ? (
        <div
          className="w-44 rounded-md border bg-card px-2 py-1.5 text-xs shadow-sm"
          data-slot="canvas-overview-cue"
        >
          <p className="font-medium">Overview</p>
          <p className="mt-0.5 text-muted-foreground">
            Zoom in to view details.
          </p>
          <Button
            className="mt-1.5 h-11 px-3 md:h-7 md:px-2"
            onClick={() => openPalette({ id: "find-node" })}
            size="xs"
            variant="outline"
          >
            Find a node
          </Button>
        </div>
      ) : null}
      <ButtonGroup orientation="vertical">
      <Button
        className="size-11 md:size-7"
        onClick={handleZoomIn}
        size="icon"
        title="Zoom in"
        variant="outline"
      >
        <ZoomIn className="size-4" />
      </Button>
      <Button
        className="size-11 md:size-7"
        onClick={handleZoomOut}
        size="icon"
        title="Zoom out"
        variant="outline"
      >
        <ZoomOut className="size-4" />
      </Button>
      <Button
        className="size-11 md:size-7"
        onClick={handleFitView}
        size="icon"
        title="Fit view"
        variant="outline"
      >
        <Maximize2 className="size-4" />
      </Button>
      <Button
        className="size-11 md:size-7"
        onClick={handleToggleMinimap}
        size="icon"
        title={showMinimap ? "Hide minimap" : "Show minimap"}
        variant="outline"
      >
        {showMinimap ? (
          <MapPin className="size-4" />
        ) : (
          <MapPinXInside className="size-4" />
        )}
      </Button>
      {onReflow ? (
        <Button
          aria-label="Reflow nodes"
          className="size-11 md:size-7"
          disabled={!canReflow}
          onClick={onReflow}
          size="icon"
          title="Reflow nodes"
          variant="outline"
        >
          <RefreshCcw className="size-4" />
        </Button>
      ) : null}
      </ButtonGroup>
    </div>
  );
};
