import { useMutation, useQuery } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useMemo } from "react";
import {
  DeleteConnectionOverlay,
  EditConnectionOverlay,
} from "#src/components/overlays/edit-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import { Button } from "#src/components/ui/button";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { Spinner } from "#src/components/ui/spinner";
import { announceTestResult } from "#src/lib/connection-credentials";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";

type IntegrationsManagerProps = {
  filter?: string;
};

export function IntegrationsManager({ filter = "" }: IntegrationsManagerProps) {
  const catalog = useExtensionCatalog();
  const { push } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();
  const canRead = can(WfGraphOperations.integrationGetAll.id);
  const canUpdate = can(WfGraphOperations.integrationUpdate.id);
  const canDelete = can(WfGraphOperations.integrationDelete.id);
  const canTest = can(WfGraphOperations.integrationTestConnection.id);
  const {
    data: integrations = [],
    isPending,
    isError,
  } = useQuery({
    ...integrationsQueryOptions(),
    enabled: canRead,
    meta: { errorMessage: "Failed to load integrations" },
  });

  const testConnection = useMutation(
    orpcQuery.integration.testConnection.mutationOptions({
      onSuccess: announceTestResult,
      meta: { errorMessage: "Connection test failed" },
    })
  );

  // A stored connection whose type is not in the catalog goes by its type and
  // offers no test: this build does not hold the integration it names.
  const integrationsWithLabels = useMemo(() => {
    const filterLower = filter.toLowerCase();

    return integrations
      .map((integration) => {
        const catalogEntry = findIntegration(catalog, integration.type);
        return {
          ...integration,
          label: catalogEntry?.label ?? integration.type,
          hasTest: catalogEntry?.hasTest === true,
          // Kept apart from the fallback label so the row can say which of the
          // two reasons it offers no test.
          known: catalogEntry !== undefined,
        };
      })
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
  }, [integrations, filter, catalog]);

  // Refreshing the connection list is the write's own business, and this screen
  // reads the same cache entry every selector does. The repair is the separate
  // job: a node stores a connection id, and a connection edited or deleted here
  // leaves that id naming something the run cannot reach.
  const handleEdit = (integration: Integration) => {
    if (!canUpdate) {
      return;
    }
    push(EditConnectionOverlay, {
      integration,
      onSuccess: repairAgainstConnectionList,
      onDelete: repairAgainstConnectionList,
    });
  };

  const handleDelete = (integration: Integration) => {
    if (!canDelete) {
      return;
    }
    push(DeleteConnectionOverlay, {
      integration,
      onSuccess: repairAgainstConnectionList,
    });
  };

  // `variables` holds the input of the call in flight, which is what the old
  // testingId state was tracking by hand.
  const testingId = testConnection.isPending
    ? testConnection.variables?.integrationId
    : undefined;

  if (isError) {
    return (
      <p className="py-8 text-center text-muted-foreground text-sm">
        Unable to load connections.
      </p>
    );
  }

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
              {integration.known ? null : (
                <span className="text-muted-foreground text-xs">
                  Not available in this build
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {integration.hasTest && canTest && (
                <Button
                  className="h-7 px-2"
                  disabled={testingId === integration.id}
                  onClick={() => {
                    if (canTest) {
                      testConnection.mutate({ integrationId: integration.id });
                    }
                  }}
                  size="sm"
                  variant="outline"
                >
                  {testingId === integration.id ? (
                    <Spinner className="size-3" />
                  ) : (
                    <span className="text-xs">Test</span>
                  )}
                </Button>
              )}
              {/* Named for the connection each one acts on. A list of icon
                  buttons all called "Edit" leaves a screen reader with no way
                  to tell which connection is about to change. */}
              {canUpdate ? (
                <Button
                  aria-label={`Edit ${integration.name}`}
                  className="size-7"
                  onClick={() => handleEdit(integration)}
                  size="icon"
                  variant="outline"
                >
                  <Pencil className="size-3" />
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  aria-label={`Delete ${integration.name}`}
                  className="size-7"
                  onClick={() => handleDelete(integration)}
                  size="icon"
                  variant="outline"
                >
                  <Trash2 className="size-3" />
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return <div className="space-y-1">{renderIntegrationsList()}</div>;
}
