import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  DeleteConnectionOverlay,
  EditConnectionOverlay,
} from "@/components/overlays/edit-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Spinner } from "@/components/ui/spinner";
import type { Integration } from "@/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "@/lib/rpc-query";
import { getIntegrationLabels } from "@rova/shared/plugins/registry";

// System integrations that don't have plugins
const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};

type IntegrationsManagerProps = {
  filter?: string;
};

export function IntegrationsManager({ filter = "" }: IntegrationsManagerProps) {
  const { push } = useOverlay();
  const queryClient = useQueryClient();
  const { data: integrations = [], isPending } = useQuery({
    ...integrationsQueryOptions(),
    meta: { errorMessage: "Failed to load integrations" },
  });

  // Every selector and every node on the canvas reads the same cache entry, so
  // one invalidation after an edit refreshes all of them.
  const invalidateIntegrations = useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: orpcQuery.integration.key() }),
    [queryClient]
  );

  const testConnection = useMutation(
    orpcQuery.integration.testConnection.mutationOptions({
      onSuccess: (result) => {
        if (result.status === "success") {
          toast.success(result.message || "Connection successful");
        } else {
          toast.error(result.message || "Connection test failed");
        }
      },
      meta: { errorMessage: "Connection test failed" },
    })
  );

  // Get integrations with their labels, sorted by label then name
  const integrationsWithLabels = useMemo(() => {
    const labels = getIntegrationLabels() as Record<string, string>;
    const filterLower = filter.toLowerCase();

    return integrations
      .map((integration) => ({
        ...integration,
        label:
          labels[integration.type] ||
          SYSTEM_INTEGRATION_LABELS[integration.type] ||
          integration.type,
      }))
      .filter((integration) => {
        if (!filter) {
          return true;
        }
        return (
          integration.label.toLowerCase().includes(filterLower) ||
          integration.name.toLowerCase().includes(filterLower) ||
          integration.type.toLowerCase().includes(filterLower)
        );
      })
      .toSorted((a, b) => {
        const labelCompare = a.label.localeCompare(b.label);
        if (labelCompare !== 0) {
          return labelCompare;
        }
        return a.name.localeCompare(b.name);
      });
  }, [integrations, filter]);

  const handleEdit = (integration: Integration) => {
    push(EditConnectionOverlay, {
      integration,
      onSuccess: invalidateIntegrations,
      onDelete: invalidateIntegrations,
    });
  };

  const handleDelete = (integration: Integration) => {
    push(DeleteConnectionOverlay, {
      integration,
      onSuccess: invalidateIntegrations,
    });
  };

  // `variables` holds the input of the call in flight, which is what the old
  // testingId state was tracking by hand.
  const testingId = testConnection.isPending
    ? testConnection.variables?.integrationId
    : undefined;

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const renderIntegrationsList = () => {
    if (integrations.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No connections configured yet
          </p>
        </div>
      );
    }

    if (integrationsWithLabels.length === 0) {
      return (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No connections match your filter
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        {integrationsWithLabels.map((integration) => (
          <div
            className="flex items-center justify-between rounded-md px-2 py-1.5"
            key={integration.id}
          >
            <div className="flex items-center gap-2">
              <IntegrationIcon
                className="size-4"
                integration={integration.type}
              />
              <span className="font-medium text-sm">{integration.label}</span>
              <span className="text-muted-foreground text-sm">
                {integration.name}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                className="h-7 px-2"
                disabled={testingId === integration.id}
                onClick={() =>
                  testConnection.mutate({ integrationId: integration.id })
                }
                size="sm"
                variant="outline"
              >
                {testingId === integration.id ? (
                  <Spinner className="size-3" />
                ) : (
                  <span className="text-xs">Test</span>
                )}
              </Button>
              <Button
                className="size-7"
                onClick={() => handleEdit(integration)}
                size="icon"
                variant="outline"
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                className="size-7"
                onClick={() => handleDelete(integration)}
                size="icon"
                variant="outline"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return <div className="space-y-1">{renderIntegrationsList()}</div>;
}
