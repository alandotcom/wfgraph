import { useQuery } from "@tanstack/react-query";
import { partition } from "es-toolkit/array";
import { AlertTriangle, Check, Circle, Pencil, Plus, Settings } from "lucide-react";
import { useCallback, useMemo } from "react";
import { ConfigureConnectionOverlay } from "#src/components/overlays/add-connection-overlay";
import { EditConnectionOverlay } from "#src/components/overlays/edit-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { Button } from "#src/components/ui/button";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { getExtensionCatalog } from "#src/lib/extensions";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";
import { cn } from "@wfgraph/shared/utils";

type IntegrationSelectorProps = {
  integrationType: string;
  value?: string;
  onChange: (integrationId: string) => void;
  onOpenSettings?: () => void;
  disabled?: boolean;
  onAddConnection?: () => void;
};

type ConnectionRowProps = {
  integration: Integration;
  /** The connection's own name, or the integration's label as a stand-in. */
  displayName: string;
  /** Whether the node this selector writes to names this connection. */
  selected: boolean;
  className: string;
  disabled?: boolean;
  onSelect: () => void;
  onEdit: () => void;
};

/**
 * One connection, and whether the node points at it.
 *
 * Written once for every count of connections. Reading `selected` is the whole
 * contract: a row that drew a check from the connection's existence claimed a
 * node was bound when its config named nothing, and the pre-run check said
 * otherwise.
 */
function ConnectionRow({
  displayName,
  selected,
  className,
  disabled,
  onSelect,
  onEdit,
}: ConnectionRowProps) {
  return (
    <div className={cn(className, disabled && "cursor-not-allowed opacity-50")}>
      <button
        aria-checked={selected}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        disabled={disabled}
        onClick={onSelect}
        role="radio"
        type="button"
      >
        {selected ? (
          <Check className="size-4 shrink-0 text-success" />
        ) : (
          <Circle className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{displayName}</span>
      </button>
      <Button
        className="size-6 shrink-0"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        size="icon"
        variant="ghost"
      >
        <Pencil className="size-3" />
      </Button>
    </div>
  );
}

export function IntegrationSelector({
  integrationType,
  value,
  onChange,
  onOpenSettings,
  disabled,
  onAddConnection,
}: IntegrationSelectorProps) {
  const { push } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();
  const { data: allIntegrations = [], isPending } = useQuery(
    integrationsQueryOptions()
  );

  const integrations = useMemo(
    () => allIntegrations.filter((i) => i.type === integrationType),
    [allIntegrations, integrationType]
  );

  const handleNewIntegrationCreated = useCallback(
    async (integrationId: string) => {
      // Editing the connection list is the only moment a node elsewhere in the
      // graph can newly be pointing at something that no longer exists, so the
      // repair runs from here rather than from an effect watching for it.
      await repairAgainstConnectionList();
      onChange(integrationId);
    },
    [repairAgainstConnectionList, onChange]
  );

  const openNewConnectionOverlay = useCallback(() => {
    push(ConfigureConnectionOverlay, {
      type: integrationType,
      onSuccess: handleNewIntegrationCreated,
    });
  }, [integrationType, push, handleNewIntegrationCreated]);

  const openEditConnectionOverlay = useCallback(
    (integration: Integration) => {
      push(EditConnectionOverlay, {
        integration,
        onSuccess: repairAgainstConnectionList,
        onDelete: repairAgainstConnectionList,
      });
    },
    [push, repairAgainstConnectionList]
  );

  const handleAddConnection = useCallback(() => {
    if (onAddConnection) {
      onAddConnection();
    } else {
      openNewConnectionOverlay();
    }
  }, [onAddConnection, openNewConnectionOverlay]);

  // isPending is false the moment the cache holds anything, so a second
  // selector mounting alongside the first shows the list rather than a skeleton.
  if (isPending) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <div className="size-4 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
          <div className="size-6 shrink-0 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const catalogEntry = findIntegration(getExtensionCatalog(), integrationType);
  const integrationLabel = catalogEntry?.label || integrationType;
  const nameOf = (integration: Integration) =>
    integration.name || `${integrationLabel} API Key`;

  // No integrations - show add button
  if (integrations.length === 0) {
    return (
      <Button
        className="w-full justify-start gap-2 border-warning/50 bg-warning/10 text-warning hover:bg-warning/20"
        disabled={disabled}
        onClick={handleAddConnection}
        variant="outline"
      >
        <AlertTriangle className="size-4" />
        <span className="flex-1 text-left">
          Add {integrationLabel} connection
        </span>
        <Plus className="size-4" />
      </Button>
    );
  }

  // Single integration - show as outlined field (not radio-style)
  if (integrations.length === 1) {
    const integration = integrations[0];

    return (
      <div role="radiogroup">
        <ConnectionRow
          className="flex h-9 w-full items-center gap-2 rounded-md border px-3 text-sm"
          disabled={disabled}
          displayName={nameOf(integration)}
          integration={integration}
          onEdit={() => openEditConnectionOverlay(integration)}
          onSelect={() => onChange(integration.id)}
          selected={value === integration.id}
        />
      </div>
    );
  }

  // Managed connections come first, which is the only thing the split decides.
  const [managed, manual] = partition(integrations, (i) => Boolean(i.isManaged));

  return (
    <div className="flex flex-col gap-1" role="radiogroup">
      {[...managed, ...manual].map((integration) => {
        const selected = value === integration.id;
        return (
          <ConnectionRow
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
              selected ? "bg-primary/10 text-primary" : "hover:bg-muted/50"
            )}
            disabled={disabled}
            displayName={nameOf(integration)}
            integration={integration}
            key={integration.id}
            onEdit={() => openEditConnectionOverlay(integration)}
            onSelect={() => onChange(integration.id)}
            selected={selected}
          />
        );
      })}

      {onOpenSettings && (
        <button
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted/50 hover:text-foreground"
          disabled={disabled}
          onClick={onOpenSettings}
          type="button"
        >
          <Settings className="size-4 shrink-0" />
          <span>Manage all connections</span>
        </button>
      )}
    </div>
  );
}
