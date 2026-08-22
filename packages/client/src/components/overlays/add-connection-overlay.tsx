import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { notifications as toast } from "#src/lib/notifications";
import { IntegrationIcon } from "#src/components/integration-icon";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  announceTestResult,
  hasProvidedConfigValues,
} from "#src/lib/connection-credentials";
import { orpcQuery, refreshIntegrations } from "#src/lib/rpc-query";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  findIntegration,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

/**
 * Everything an operator may connect to, from the one place that knows: the
 * catalog. The database connection is in it like any other, so this list needs no
 * second source and no ordering rule of its own.
 */
function connectableIntegrations(catalog: ExtensionCatalog) {
  return catalog.integrations.toSorted((a, b) =>
    a.label.localeCompare(b.label)
  );
}

const getLabel = (catalog: ExtensionCatalog, type: string): string =>
  findIntegration(catalog, type)?.label ?? type;

type AddConnectionOverlayProps = {
  overlayId: string;
  onSuccess?: (integrationId: string) => void;
};

/**
 * Overlay for selecting a connection type to add
 */
export function AddConnectionOverlay({
  overlayId,
  onSuccess,
}: AddConnectionOverlayProps) {
  const catalog = useExtensionCatalog();
  const { push } = useOverlay();
  const [searchQuery, setSearchQuery] = useState("");
  const isMobile = useIsMobile();

  // Plain render work: the catalog is fixed for the process and the list is short,
  // and `connectableIntegrations` builds a fresh array every render anyway, so a
  // memo keyed on it would never hit.
  const query = searchQuery.trim().toLowerCase();
  const filtered = connectableIntegrations(catalog).filter(
    (integration) => !query || integration.label.toLowerCase().includes(query)
  );

  const handleSelectType = (type: string) => {
    // Push to configure overlay
    push(ConfigureConnectionOverlay, { type, onSuccess });
  };

  return (
    <Overlay overlayId={overlayId} title="Add Connection">
      <Text color="secondary">Select a service to connect</Text>

      <VStack gap={3}>
        <TextInput
          hasAutoFocus={!isMobile}
          isLabelHidden
          label="Search services"
          onChange={setSearchQuery}
          placeholder="Search services"
          startIcon={<Icon icon={Search} size="sm" />}
          value={searchQuery}
          width="100%"
        />
        <VStack gap={1} xstyle={styles.serviceList}>
          {filtered.length === 0 ? (
            <Text color="secondary">No services found</Text>
          ) : (
            filtered.map((integration) => (
              <ClickableCard
                key={integration.type}
                label={integration.label}
                onClick={() => handleSelectType(integration.type)}
                padding={2}
                variant="transparent"
              >
                <HStack align="center" gap={3}>
                  <IntegrationIcon integration={integration.type} />
                  <VStack gap={0.5}>
                    <Text type="label">{integration.label}</Text>
                    {integration.description ? (
                      <Text color="secondary" maxLines={2} type="supporting">
                        {integration.description}
                      </Text>
                    ) : null}
                  </VStack>
                </HStack>
              </ClickableCard>
            ))
          )}
        </VStack>
      </VStack>
    </Overlay>
  );
}

type ConfigureConnectionOverlayProps = {
  overlayId: string;
  type: string;
  onSuccess?: (integrationId: string) => void;
};

/**
 * Secret field component for password inputs
 */
function SecretField({
  fieldId: _fieldId,
  label,
  configKey,
  placeholder,
  helpText,
  helpLink,
  value,
  onChange,
}: {
  fieldId: string;
  label: string;
  configKey: string;
  placeholder?: string;
  helpText?: string;
  helpLink?: { url: string; text: string };
  value: string;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <VStack gap={2}>
      <TextInput
        label={label}
        onChange={(next) => onChange(configKey, next)}
        placeholder={placeholder}
        type="password"
        value={value}
        width="100%"
      />
      {(helpText || helpLink) && (
        <Text color="secondary" type="supporting">
          {helpText}
          {helpLink && (
            <a href={helpLink.url} rel="noopener noreferrer" target="_blank">
              {helpLink.text}
            </a>
          )}
        </Text>
      )}
    </VStack>
  );
}

/**
 * Overlay for configuring a new connection
 */
export function ConfigureConnectionOverlay({
  overlayId,
  type,
  onSuccess,
}: ConfigureConnectionOverlayProps) {
  const catalog = useExtensionCatalog();
  const { push, closeAll } = useOverlay();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const create = useMutation(
    orpcQuery.integration.create.mutationOptions({
      onSuccess: async (newIntegration) => {
        toast.success("Connection created");
        // Before the caller hears about it: every consumer of the new id reads
        // the connection list to resolve it.
        await refreshIntegrations(queryClient);
        onSuccess?.(newIntegration.id);
        closeAll();
      },
      meta: { errorMessage: "Failed to save connection" },
    })
  );

  // A test run as part of saving, whose failure is an offer to save anyway
  // rather than something to toast.
  const testForSave = useMutation(
    orpcQuery.integration.testCredentials.mutationOptions({
      meta: { errorShownByCaller: true },
    })
  );

  const testNewCredentials = useMutation(
    orpcQuery.integration.testCredentials.mutationOptions({
      onSuccess: announceTestResult,
    })
  );

  const catalogEntry = findIntegration(catalog, type);
  const formFields = catalogEntry?.credentialFields;
  // Whether this integration has a connection test at all. An integration that
  // declares none has nothing to press and nothing to run before a save.
  const hasTest = catalogEntry?.hasTest === true;

  const saving = create.isPending || testForSave.isPending;

  const saveConnection = () => {
    create.mutate({ name: name.trim(), type, config });
  };

  const offerToSaveAnyway = (reason: string) => {
    push(ConfirmOverlay, {
      title: "Connection Test Failed",
      message: `${reason}\n\nDo you want to save anyway?`,
      confirmLabel: "Save Anyway",
      onConfirm: saveConnection,
    });
  };

  const handleSave = async () => {
    const hasConfig = hasProvidedConfigValues(config);
    if (!hasConfig) {
      toast.error("Please enter credentials");
      return;
    }

    if (!hasTest) {
      saveConnection();
      return;
    }

    // Test before saving
    try {
      const result = await testForSave.mutateAsync({ type, config });

      if (result.status === "error") {
        offerToSaveAnyway(`The test failed: ${result.message}`);
        return;
      }
    } catch (error) {
      offerToSaveAnyway(
        error instanceof Error ? error.message : "Failed to test connection"
      );
      return;
    }

    saveConnection();
  };

  const handleTest = () => {
    const hasConfig = hasProvidedConfigValues(config);
    if (!hasConfig) {
      toast.error("Please enter credentials first");
      return;
    }

    testNewCredentials.mutate({ type, config });
  };

  const renderConfigFields = () => {
    if (!formFields) {
      return null;
    }

    return Object.entries(formFields).map(([configKey, field]) => {
      if (field.type === "password") {
        return (
          <SecretField
            configKey={configKey}
            fieldId={configKey}
            helpLink={field.helpLink}
            helpText={field.helpText}
            key={configKey}
            label={field.label}
            onChange={updateConfig}
            placeholder={field.placeholder}
            value={config[configKey] || ""}
          />
        );
      }

      return (
        <VStack gap={2} key={configKey}>
          <TextInput
            label={field.label}
            onChange={(next) => updateConfig(configKey, next)}
            placeholder={field.placeholder}
            type="text"
            value={config[configKey] || ""}
            width="100%"
          />
          {(field.helpText || field.helpLink) && (
            <Text color="secondary" type="supporting">
              {field.helpText}
              {field.helpLink && (
                <a
                  href={field.helpLink.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {field.helpLink.text}
                </a>
              )}
            </Text>
          )}
        </VStack>
      );
    });
  };

  return (
    <Overlay
      actions={[
        ...(hasTest
          ? [
              {
                label: "Test",
                variant: "secondary" as const,
                onClick: handleTest,
                loading: testNewCredentials.isPending,
                disabled: saving,
              },
            ]
          : []),
        { label: "Create", onClick: handleSave, loading: saving },
      ]}
      overlayId={overlayId}
      title={`Add ${getLabel(catalog, type)}`}
    >
      <Text color="secondary">Enter your credentials</Text>

      <VStack gap={4}>
        {renderConfigFields()}

        <TextInput
          isOptional
          label="Label"
          onChange={setName}
          placeholder="e.g. Production, Personal, Work"
          value={name}
          width="100%"
        />
      </VStack>
    </Overlay>
  );
}

const styles = stylex.create({
  serviceList: {
    maxHeight: 300,
    overflowY: "auto",
  },
});
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import * as stylex from "@stylexjs/stylex";
