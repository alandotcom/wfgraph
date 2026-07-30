import { useMutation, useQuery } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useMemo } from "react";
import {
  DeleteConnectionOverlay,
  EditConnectionOverlay,
} from "#src/components/overlays/edit-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { Button } from "#src/components/ui/button";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { Spinner } from "#src/components/ui/spinner";
import { announceTestResult } from "#src/lib/connection-credentials";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "#src/lib/rpc-query";
import { integrationLabels } from "#src/lib/extensions";

// System integrations that don't have plugins
const SYSTEM_INTEGRATION_LABELS: Record<string, string> = {
  database: "Database",
};

type IntegrationsManagerProps = {
  filter?: string;
};

export function IntegrationsManager({ filter = "" }: IntegrationsManagerProps) {
  const { push } = useOverlay();
  const { data: integrations = [], isPending } = useQuery({
    ...integrationsQueryOptions(),
    meta: { errorMessage: "Failed to load integrations" },
  });

  const testConnection = useMutation(
    orpcQuery.integration.testConnection.mutationOptions({
      onSuccess: announceTestResult,
      meta: { errorMessage: "Connection test failed" },
    })
  );

  // Get integrations with their labels, sorted by label then name
  const integrationsWithLabels = useMemo(() => {
    const labels = integrationLabels();
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

  // No onSuccess: refreshing the connection list is the write's own business
  // now, and this screen reads the same cache entry every selector does.
  const handleEdit = (integration: Integration) => {
    push(EditConnectionOverlay, { integration });
  };

  const handleDelete = (integration: Integration) => {
    push(DeleteConnectionOverlay, { integration });
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
