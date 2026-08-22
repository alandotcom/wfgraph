import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery } from "@tanstack/react-query";
import { partition } from "es-toolkit/array";
import { AlertTriangle, Pencil, Plus, Settings } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { ConfigureConnectionOverlay } from "#src/components/overlays/add-connection-overlay";
import { EditConnectionOverlay } from "#src/components/overlays/edit-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";

type IntegrationSelectorProps = {
  integrationType: string;
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
  const catalog = useExtensionCatalog();
  const { push } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();
  const { data: allIntegrations = [], isPending } = useQuery(
    integrationsQueryOptions()
  );

  const integrations = useMemo(
    () => allIntegrations.filter((entry) => entry.type === integrationType),
    [allIntegrations, integrationType]
  );

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
      return;
    }
    openNewConnectionOverlay();
  }, [onAddConnection, openNewConnectionOverlay]);

  if (isPending) {
    return <Spinner label="Loading connections" />;
  }

  const catalogEntry = findIntegration(catalog, integrationType);
  const integrationLabel = catalogEntry?.label || integrationType;
  const nameOf = (integration: Integration) =>
    integration.name || `${integrationLabel} API Key`;

  if (integrations.length === 0) {
    return (
      <Button
        icon={<Icon icon={AlertTriangle} size="sm" />}
        isDisabled={disabled}
        label={`Add ${integrationLabel} connection`}
        onClick={handleAddConnection}
        variant="secondary"
        width="100%"
      />
    );
  }

  const [managed, manual] = partition(integrations, (entry) =>
    Boolean(entry.isManaged)
  );
  const ordered = [...managed, ...manual];

  return (
    <VStack gap={2}>
      <RadioList
        isDisabled={disabled}
        isLabelHidden
        label={`${integrationLabel} connection`}
        onChange={onChange}
        value={value ?? ""}
        width="100%"
      >
        {ordered.map((integration) => (
          <RadioListItem
            endContent={
              <IconButton
                icon={<Icon icon={Pencil} size="sm" />}
                isDisabled={disabled}
                label={`Edit ${nameOf(integration)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  openEditConnectionOverlay(integration);
                }}
                size="sm"
                variant="ghost"
              />
            }
            key={integration.id}
            label={nameOf(integration)}
            value={integration.id}
          />
        ))}
      </RadioList>
      <HStack gap={2} wrap="wrap">
        <Button
          icon={<Icon icon={Plus} size="sm" />}
          isDisabled={disabled}
          label="Add connection"
          onClick={handleAddConnection}
          size="sm"
          variant="ghost"
        />
        {onOpenSettings ? (
          <Button
            icon={<Icon icon={Settings} size="sm" />}
            isDisabled={disabled}
            label="Manage all connections"
            onClick={onOpenSettings}
            size="sm"
            variant="ghost"
          />
        ) : null}
      </HStack>
    </VStack>
  );
}
