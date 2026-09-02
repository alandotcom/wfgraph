import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Input } from "#src/components/ui/input";
import { IntegrationIcon } from "#src/components/ui/integration-icon";
import { Label } from "#src/components/ui/label";
import { useIsMobile } from "#src/hooks/use-mobile";
import { useOAuthConnection } from "#src/hooks/use-oauth-connection";
import {
  announceTestResult,
  hasProvidedConfigValues,
} from "#src/lib/connection-credentials";
import { orpcQuery, refreshIntegrations } from "#src/lib/rpc-query";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { can } from "#src/lib/authorization";
import {
  findIntegration,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { compareText } from "@wfgraph/shared/types/string";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

/**
 * Everything an operator may connect to, from the one place that knows: the
 * catalog. The database connection is in it like any other, so this list needs no
 * second source and no ordering rule of its own.
 */
function connectableIntegrations(catalog: ExtensionCatalog) {
  return catalog.integrations.toSorted((a, b) => compareText(a.label, b.label));
}

const getLabel = (catalog: ExtensionCatalog, type: string): string =>
  findIntegration(catalog, type)?.label ?? type;

type AddConnectionOverlayProps = {
  overlayId: string;
  onSuccess?: ((integrationId: string) => void) | undefined;
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
  onSuccess?: ((integrationId: string) => void) | undefined;
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
  placeholder?: string | undefined;
  helpText?: string | undefined;
  helpLink?: { url: string; text: string } | undefined;
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
  const catalog = useExtensionCatalog();
  const { push, closeAll } = useOverlay();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const canCreate = can(WfGraphOperations.integrationCreate.id);
  const canReadIntegrations = can(WfGraphOperations.integrationGetAll.id);
  const canTestCredentials = can(
    WfGraphOperations.integrationTestCredentials.id
  );

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const create = useMutation(
    orpcQuery.integration.create.mutationOptions({
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
  const oauthConnection = useOAuthConnection({
    onConnected: (integrationId) => {
      onSuccess?.(integrationId);
      closeAll();
    },
  });
  const oauthPending = oauthConnection.pending;
  // Whether this integration has a connection test at all. An integration that
  // declares none has nothing to press and nothing to run before a save.
  const hasTest = catalogEntry?.hasTest === true;

  const saving = create.isPending || testForSave.isPending || oauthPending;

  const saveConnection = async () => {
    if (!canCreate) {
      return;
    }
    try {
      const newIntegration = await create.mutateAsync({
        name: name.trim(),
        type,
        config,
      });
      toast.success("Connection created");
      // Before the caller hears about it: every consumer of the new id reads the
      // connection list to resolve it.
      if (canReadIntegrations) {
        await refreshIntegrations(queryClient, newIntegration.id);
      }
      onSuccess?.(newIntegration.id);
      closeAll();
    } catch {
      // The create mutation's shared error handling already announces failures.
    }
  };

  const handleOAuthCreate = async () => {
    await oauthConnection.startCreated({
      name: name.trim(),
      type,
      // OAuth replaces only the credential keys it receives from the
      // provider. Keep every setting entered here for the encrypted row.
      config,
    });
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

    if (!(hasTest && canTestCredentials)) {
      await saveConnection();
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

    await saveConnection();
  };

  const handleTest = () => {
    if (!canTestCredentials) {
      return;
    }
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
        <div className="space-y-2" key={configKey}>
          <Label htmlFor={configKey}>{field.label}</Label>
          <Input
            id={configKey}
            onChange={(e) => updateConfig(configKey, e.target.value)}
            placeholder={field.placeholder}
            type={field.type}
            value={config[configKey] || ""}
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
        ...(hasTest && canTestCredentials
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
        ...(catalogEntry?.oauth
          ? [
              ...(canCreate
                ? [
                    {
                      label: "Create manually",
                      variant: "outline" as const,
                      onClick: handleSave,
                      loading: create.isPending && !oauthPending,
                      disabled: saving,
                    },
                  ]
                : []),
              ...(oauthConnection.canStart
                ? [
                    {
                      label: `Connect with ${catalogEntry.oauth.label}`,
                      onClick: handleOAuthCreate,
                      loading: oauthPending,
                      disabled: saving && !oauthPending,
                    },
                  ]
                : []),
            ]
          : canCreate
            ? [{ label: "Create", onClick: handleSave, loading: saving }]
            : []),
      ]}
      overlayId={overlayId}
      title={`Add ${getLabel(catalog, type)}`}
    >
      {catalogEntry?.oauth ? (
        <div className="-mt-2 mb-4 rounded-md border bg-muted/30 p-3">
          <h3 className="font-medium text-sm">
            Connect with {catalogEntry.oauth.label}
          </h3>
          <p className="mt-1 text-muted-foreground text-sm">
            Authorize this connection in {catalogEntry.oauth.label}. You can
            still enter settings below when this provider needs them.
          </p>
        </div>
      ) : (
        <p className="-mt-2 mb-4 text-muted-foreground text-sm">
          Enter your credentials
        </p>
      )}

      <fieldset
        aria-busy={oauthPending}
        className="m-0 min-w-0 space-y-4 border-0 p-0"
        disabled={oauthPending}
      >
        {catalogEntry?.oauth && (
          <h3 className="font-medium text-sm">Manual configuration</h3>
        )}
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
      </fieldset>
    </Overlay>
  );
}
