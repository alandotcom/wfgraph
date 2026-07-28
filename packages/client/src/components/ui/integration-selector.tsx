import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import {
  AlertTriangle,
  Check,
  Circle,
  Pencil,
  Plus,
  Settings,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { EditConnectionOverlay } from "@/components/overlays/edit-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import type { Integration } from "@/lib/rpc-client";
import { integrationsQueryOptions } from "@/lib/rpc-query";
import { repairIntegrationsAtom } from "@/lib/workflow-graph-store";
import { getIntegration } from "@rova/shared/plugins/registry";
import type { IntegrationType } from "@rova/shared/types/integration";
import { cn } from "@rova/shared/utils";

type IntegrationSelectorProps = {
  integrationType: IntegrationType;
  value?: string;
  onChange: (integrationId: string) => void;
  onOpenSettings?: () => void;
  disabled?: boolean;
  onAddConnection?: () => void;
};

export function IntegrationSelector({
  integrationType,
  value,
  onChange,
  onOpenSettings,
  disabled,
  onAddConnection,
}: IntegrationSelectorProps) {
  const { push } = useOverlay();
  const queryClient = useQueryClient();
  const repairIntegrations = useSetAtom(repairIntegrationsAtom);
  const { data: allIntegrations = [], isPending } = useQuery(
    integrationsQueryOptions()
  );

  const integrations = useMemo(
    () => allIntegrations.filter((i) => i.type === integrationType),
    [allIntegrations, integrationType]
  );

  // Editing the connection list is the only moment a node elsewhere in the
  // graph can newly be pointing at something that no longer exists, so the
  // repair runs from here rather than from an effect watching for the mismatch.
  //
  // `fetchQuery` rather than `ensureQueryData`: the latter hands back whatever
  // is cached without consulting staleness, so it would only be correct while
  // some selector happens to be mounted and observing the entry the write just
  // invalidated. Repairing against a pre-write list is what points a node at a
  // connection that is gone.
  const repairAgainstConnectionList = useCallback(async () => {
    repairIntegrations(
      await queryClient.fetchQuery(integrationsQueryOptions())
    );
  }, [queryClient, repairIntegrations]);

  const handleNewIntegrationCreated = useCallback(
    async (integrationId: string) => {
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

  const plugin = getIntegration(integrationType);
  const integrationLabel = plugin?.label || integrationType;

  // Separate managed and manual integrations for AI Gateway
  const managedIntegrations = integrations.filter((i) => i.isManaged);
  const manualIntegrations = integrations.filter((i) => !i.isManaged);

  // No integrations - show add button
  if (integrations.length === 0) {
    return (
      <>
        <Button
          className="w-full justify-start gap-2 border-orange-500/50 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 dark:text-orange-400"
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
      </>
    );
  }

  // Single integration - show as outlined field (not radio-style)
  if (integrations.length === 1) {
    const integration = integrations[0];
    const displayName = integration.name || `${integrationLabel} API Key`;

    return (
      <>
        <div
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border px-3 text-sm",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          <Check className="size-4 shrink-0 text-green-600" />
          <span className="flex-1 truncate">{displayName}</span>
          <Button
            className="size-6 shrink-0"
            disabled={disabled}
            onClick={() => openEditConnectionOverlay(integration)}
            size="icon"
            variant="ghost"
          >
            <Pencil className="size-3" />
          </Button>
        </div>
      </>
    );
  }

  // Multiple integrations or AI Gateway with option to add managed key
  return (
    <>
      <div className="flex flex-col gap-1">
        {/* Show managed integrations first */}
        {managedIntegrations.map((integration) => {
          const isSelected = value === integration.id;
          const displayName = integration.name || `${integrationLabel} API Key`;
          return (
            <div
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-[13px] py-1.5 text-sm transition-colors",
                isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted/50",
                disabled && "cursor-not-allowed opacity-50"
              )}
              key={integration.id}
            >
              <button
                className="flex flex-1 items-center gap-2 text-left"
                disabled={disabled}
                onClick={() => onChange(integration.id)}
                type="button"
              >
                {isSelected ? (
                  <Check className="size-4 shrink-0" />
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
                  openEditConnectionOverlay(integration);
                }}
                size="icon"
                variant="ghost"
              >
                <Pencil className="size-3" />
              </Button>
            </div>
          );
        })}

        {/* Show manual integrations */}
        {manualIntegrations.map((integration) => {
          const isSelected = value === integration.id;
          const displayName = integration.name || `${integrationLabel} API Key`;
          return (
            <div
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-[13px] py-1.5 text-sm transition-colors",
                isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted/50",
                disabled && "cursor-not-allowed opacity-50"
              )}
              key={integration.id}
            >
              <button
                className="flex flex-1 items-center gap-2 text-left"
                disabled={disabled}
                onClick={() => onChange(integration.id)}
                type="button"
              >
                {isSelected ? (
                  <Check className="size-4 shrink-0" />
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
                  openEditConnectionOverlay(integration);
                }}
                size="icon"
                variant="ghost"
              >
                <Pencil className="size-3" />
              </Button>
            </div>
          );
        })}

        {onOpenSettings && (
          <button
            className="flex w-full items-center gap-2 rounded-md px-[13px] py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted/50 hover:text-foreground"
            disabled={disabled}
            onClick={onOpenSettings}
            type="button"
          >
            <Settings className="size-4 shrink-0" />
            <span>Manage all connections</span>
          </button>
        )}
      </div>
    </>
  );
}
