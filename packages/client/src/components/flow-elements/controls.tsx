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
import { workflowFitViewOptions } from "#src/components/workflow/workflow-viewport";
import { viewportAnimationDuration } from "#src/lib/motion";
import { showMinimapAtom } from "#src/lib/workflow-ui-store";

type ControlsProps = {
  onReflow?: (() => void) | undefined;
  canReflow?: boolean | undefined;
};

export const Controls = ({ onReflow, canReflow = true }: ControlsProps) => {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
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

  return (
    <ButtonGroup orientation="vertical">
      <Button
        onClick={handleZoomIn}
        size="icon"
        title="Zoom in"
        variant="outline"
      >
        <ZoomIn className="size-4" />
      </Button>
      <Button
        onClick={handleZoomOut}
        size="icon"
        title="Zoom out"
        variant="outline"
      >
        <ZoomOut className="size-4" />
      </Button>
      <Button
        onClick={handleFitView}
        size="icon"
        title="Fit view"
        variant="outline"
      >
        <Maximize2 className="size-4" />
      </Button>
      <Button
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
  );
};
