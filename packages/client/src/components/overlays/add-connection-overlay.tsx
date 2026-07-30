import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Input } from "#src/components/ui/input";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { Label } from "#src/components/ui/label";
import { useIsMobile } from "#src/hooks/use-mobile";
import {
  announceTestResult,
  hasProvidedConfigValues,
} from "#src/lib/connection-credentials";
import { orpcQuery, refreshIntegrations } from "#src/lib/rpc-query";
import { getExtensionCatalog } from "#src/lib/extensions";
import { findIntegration } from "@rova/shared/extensions/catalog";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

/**
 * Everything an operator may connect to, from the one place that knows: the
 * catalog. The database connection is in it like any other, so this list needs no
 * second source and no ordering rule of its own.
 */
const connectableIntegrations = () =>
  getExtensionCatalog().integrations.toSorted((a, b) =>
    a.label.localeCompare(b.label)
  );

const getLabel = (type: string): string =>
  findIntegration(getExtensionCatalog(), type)?.label ?? type;

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
  const { push } = useOverlay();
  const [searchQuery, setSearchQuery] = useState("");
  const isMobile = useIsMobile();

  // Plain render work: the catalog is fixed for the process and the list is short,
  // and `connectableIntegrations` builds a fresh array every render anyway, so a
  // memo keyed on it would never hit.
  const query = searchQuery.trim().toLowerCase();
  const filtered = connectableIntegrations().filter(
    (integration) => !query || integration.label.toLowerCase().includes(query)
  );

  const handleSelectType = (type: string) => {
    // Push to configure overlay
    push(ConfigureConnectionOverlay, { type, onSuccess });
  };

  return (
    <Overlay overlayId={overlayId} title="Add Connection">
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Select a service to connect
      </p>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus={!isMobile}
            className="pl-9"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search services..."
            value={searchQuery}
          />
        </div>
        <div className="max-h-[300px] space-y-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground text-sm">
              No services found
            </p>
          ) : (
            filtered.map((integration) => (
              <button
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                key={integration.type}
                onClick={() => handleSelectType(integration.type)}
                type="button"
              >
                <IntegrationIcon
                  className="size-5 shrink-0"
                  integration={integration.type}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{integration.label}</span>
                  {integration.description && (
                    <span className="text-muted-foreground text-xs">
                      {" "}
                      - {integration.description}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
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
  fieldId,
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
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input
        className="flex-1"
        id={fieldId}
        onChange={(e) => onChange(configKey, e.target.value)}
        placeholder={placeholder}
        type="password"
        value={value}
      />
      {(helpText || helpLink) && (
        <p className="text-muted-foreground text-xs">
          {helpText}
          {helpLink && (
            <a
              className="underline hover:text-foreground"
              href={helpLink.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {helpLink.text}
            </a>
          )}
        </p>
      )}
    </div>
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

  const catalogEntry = findIntegration(getExtensionCatalog(), type);
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

  // Render config fields
  const renderConfigFields = () => {
    if (!formFields) {
      return null;
    }

    return formFields.map((field) => {
      if (field.type === "password") {
        return (
          <SecretField
            configKey={field.configKey}
            fieldId={field.configKey}
            helpLink={field.helpLink}
            helpText={field.helpText}
            key={field.configKey}
            label={field.label}
            onChange={updateConfig}
            placeholder={field.placeholder}
            value={config[field.configKey] || ""}
          />
        );
      }

      return (
        <div className="space-y-2" key={field.configKey}>
          <Label htmlFor={field.configKey}>{field.label}</Label>
          <Input
            id={field.configKey}
            onChange={(e) => updateConfig(field.configKey, e.target.value)}
            placeholder={field.placeholder}
            type={field.type}
            value={config[field.configKey] || ""}
          />
          {(field.helpText || field.helpLink) && (
            <p className="text-muted-foreground text-xs">
              {field.helpText}
              {field.helpLink && (
                <a
                  className="underline hover:text-foreground"
                  href={field.helpLink.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {field.helpLink.text}
                </a>
              )}
            </p>
          )}
        </div>
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
                variant: "outline" as const,
                onClick: handleTest,
                loading: testNewCredentials.isPending,
                disabled: saving,
              },
            ]
          : []),
        { label: "Create", onClick: handleSave, loading: saving },
      ]}
      overlayId={overlayId}
      title={`Add ${getLabel(type)}`}
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Enter your credentials
      </p>

      <div className="space-y-4">
        {renderConfigFields()}

        <div className="space-y-2">
          <Label htmlFor="name">Label (Optional)</Label>
          <Input
            id="name"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Production, Personal, Work"
            value={name}
          />
        </div>
      </div>
    </Overlay>
  );
}
