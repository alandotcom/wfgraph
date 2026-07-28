import { Search } from "lucide-react";
import { useCallback, useState } from "react";
import { IntegrationsManager } from "@/components/settings/integrations-manager";
import { Input } from "@/components/ui/input";
import { AddConnectionOverlay } from "./add-connection-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type IntegrationsOverlayProps = {
  overlayId: string;
};

export function IntegrationsOverlay({ overlayId }: IntegrationsOverlayProps) {
  const { push, closeAll } = useOverlay();
  const [filter, setFilter] = useState("");

  const handleAddConnection = () => {
    push(AddConnectionOverlay, {});
  };

  const handleClose = useCallback(() => closeAll(), [closeAll]);

  return (
    <Overlay
      actions={[
        {
          label: "Add Connection",
          variant: "outline",
          onClick: handleAddConnection,
        },
        { label: "Done", onClick: handleClose },
      ]}
      overlayId={overlayId}
      title="Connections"
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Manage API keys and credentials used by your workflows
      </p>

      <div className="space-y-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter connections..."
            value={filter}
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          <IntegrationsManager filter={filter} />
        </div>
      </div>
    </Overlay>
  );
}
