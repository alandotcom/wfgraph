import { Search } from "lucide-react";
import { useCallback, useState } from "react";
import { IntegrationsManager } from "#src/components/settings/integrations-manager";
import { Input } from "#src/components/ui/input";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import { AddConnectionOverlay } from "./add-connection-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type IntegrationsOverlayProps = {
  overlayId: string;
};

export function IntegrationsOverlay({ overlayId }: IntegrationsOverlayProps) {
  const { push, closeAll } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();
  const [filter, setFilter] = useState("");

  // A new connection can be the one a node was already asking for, so the
  // repair runs here for the same reason it runs on an edit or a delete.
  const handleAddConnection = () => {
    push(AddConnectionOverlay, {
      onSuccess: () => void repairAgainstConnectionList(),
    });
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
