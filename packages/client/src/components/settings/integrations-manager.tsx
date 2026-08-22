import { useMutation, useQuery } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useMemo } from "react";
import {
  DeleteConnectionOverlay,
  EditConnectionOverlay,
} from "#src/components/overlays/edit-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { IntegrationIcon } from "#src/components/integration-icon";
import { announceTestResult } from "#src/lib/connection-credentials";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions, orpcQuery } from "#src/lib/rpc-query";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";

type IntegrationsManagerProps = {
  filter?: string;
};

export function IntegrationsManager({ filter = "" }: IntegrationsManagerProps) {
  const catalog = useExtensionCatalog();
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
    return <Spinner label="Loading connections" />;
  }

  const renderIntegrationsList = () => {
    if (integrations.length === 0) {
      return <EmptyState isCompact title="No connections configured yet" />;
    }

    if (integrationsWithLabels.length === 0) {
      return <EmptyState isCompact title="No connections match your filter" />;
    }

    return (
      <List density="balanced" hasDividers>
        {integrationsWithLabels.map((integration) => (
          <ListItem
            description={
              <VStack gap={0.5}>
                <Text color="secondary">{integration.name}</Text>
                {integration.known ? null : (
                  <Text color="secondary" type="supporting">
                    Not available in this build
                  </Text>
                )}
              </VStack>
            }
            endContent={
              <HStack gap={1}>
                {integration.hasTest ? (
                  <Button
                    isDisabled={testingId === integration.id}
                    isLoading={testingId === integration.id}
                    label="Test"
                    onClick={() =>
                      testConnection.mutate({ integrationId: integration.id })
                    }
                    size="sm"
                    variant="secondary"
                  />
                ) : null}
                <IconButton
                  icon={<Icon icon={Pencil} size="sm" />}
                  label={`Edit ${integration.name}`}
                  onClick={() => handleEdit(integration)}
                  size="sm"
                  variant="ghost"
                />
                <IconButton
                  icon={<Icon icon={Trash2} size="sm" />}
                  label={`Delete ${integration.name}`}
                  onClick={() => handleDelete(integration)}
                  size="sm"
                  variant="ghost"
                />
              </HStack>
            }
            key={integration.id}
            label={integration.label}
            startContent={<IntegrationIcon integration={integration.type} />}
          />
        ))}
      </List>
    );
  };

  return renderIntegrationsList();
}
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
