import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/VStack";
import { useReactFlow } from "@xyflow/react";
import { useAtom } from "jotai";
import { MapPin, MapPinXInside, Maximize2, RefreshCcw, ZoomIn, ZoomOut } from "lucide-react";
import { showMinimapAtom } from "#src/lib/workflow-ui-store";

type ControlsProps = { onReflow?: () => void; canReflow?: boolean };

export const Controls = ({ onReflow, canReflow = true }: ControlsProps) => {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [showMinimap, setShowMinimap] = useAtom(showMinimapAtom);

  return (
    <VStack gap={1}>
      <IconButton icon={<Icon icon={ZoomIn} size="sm" />} label="Zoom in" onClick={() => void zoomIn()} size="sm" variant="secondary" />
      <IconButton icon={<Icon icon={ZoomOut} size="sm" />} label="Zoom out" onClick={() => void zoomOut()} size="sm" variant="secondary" />
      <IconButton icon={<Icon icon={Maximize2} size="sm" />} label="Fit view" onClick={() => void fitView({ padding: 0.2, duration: 300 })} size="sm" variant="secondary" />
      <IconButton icon={<Icon icon={showMinimap ? MapPin : MapPinXInside} size="sm" />} label={showMinimap ? "Hide minimap" : "Show minimap"} onClick={() => setShowMinimap(!showMinimap)} size="sm" variant="secondary" />
      {onReflow ? <IconButton icon={<Icon icon={RefreshCcw} size="sm" />} isDisabled={!canReflow} label="Reflow nodes" onClick={onReflow} size="sm" variant="secondary" /> : null}
    </VStack>
  );
};
