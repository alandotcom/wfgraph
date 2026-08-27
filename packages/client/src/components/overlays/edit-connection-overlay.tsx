import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Link, Pencil, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import { useIsMobile } from "#src/hooks/use-mobile";
import { useOAuthConnection } from "#src/hooks/use-oauth-connection";
import {
  announceTestResult,
  hasProvidedConfigValues,
} from "#src/lib/connection-credentials";
import type { Integration } from "#src/lib/rpc-client";
import { orpcQuery, refreshIntegrations } from "#src/lib/rpc-query";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  findIntegration,
  type IntegrationMetadata,
} from "@wfgraph/shared/extensions/catalog";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

/** An integration's label, falling back to its type when the catalog lacks it. */
const integrationLabel = (
  entry: IntegrationMetadata | undefined,
  type: string
): string => entry?.label ?? type;

function OAuthConnectionStatus({
  oauth,
  providerLabel,
  pending,
  onConnect,
  onDisconnect,
}: {
  oauth: Integration["oauth"];
  providerLabel: string;
  pending: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (oauth?.status === "connected") {
    return (
      <section
        aria-busy={pending}
        aria-label={`${providerLabel} OAuth connection`}
        className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-start gap-2" role="status">
          <Check aria-hidden="true" className="mt-0.5 size-4 text-success" />
          <div className="space-y-0.5 text-sm">
            <p className="font-medium">Connected</p>
            {oauth.accountLabel && (
              <p className="text-muted-foreground">
                Account: {oauth.accountLabel}
              </p>
            )}
            <p className="text-muted-foreground">
              Connected on {oauth.connectedAt.slice(0, 10)}
            </p>
          </div>
        </div>
        <Button
          disabled={pending}
          onClick={onDisconnect}
          type="button"
          variant="outline"
        >
          Disconnect
        </Button>
      </section>
    );
  }

  const needsReauthorization = oauth?.status === "reauthorization_required";
  return (
    <section
      aria-busy={pending}
      aria-label={`${providerLabel} OAuth connection`}
      className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2" role="status">
        {needsReauthorization ? (
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 text-warning"
          />
        ) : (
          <Link aria-hidden="true" className="mt-0.5 size-4" />
        )}
        <div className="space-y-0.5 text-sm">
          <p className="font-medium">
            {needsReauthorization ? "Reauthorization required" : "Disconnected"}
          </p>
          <p className="text-muted-foreground">
            {needsReauthorization
              ? `Reconnect ${providerLabel} to continue using this connection.`
              : `Connect ${providerLabel} to authorize this connection.`}
          </p>
        </div>
      </div>
      <Button disabled={pending} onClick={onConnect} type="button">
        {needsReauthorization ? "Reconnect" : "Connect"}
      </Button>
    </section>
  );
}

type EditConnectionOverlayProps = {
  overlayId: string;
  integration: Integration;
  onSuccess?: () => void;
  onDelete?: () => void;
};

/**
 * Secret field with "Configured" state for edit mode
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
  const [isEditing, setIsEditing] = useState(false);
  const isMobile = useIsMobile();
  const hasNewValue = value.length > 0;

  if (!(isEditing || hasNewValue)) {
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{label}</Label>
        <div className="flex items-center gap-2">
          <div className="flex h-9 flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3">
            <Check className="size-4 text-success" />
            <span className="text-muted-foreground text-sm">Configured</span>
          </div>
          <Button
            onClick={() => setIsEditing(true)}
            type="button"
            variant="outline"
          >
            <Pencil className="mr-1.5 size-3" />
            Change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          autoFocus={isEditing && !isMobile}
          className="flex-1"
          id={fieldId}
          onChange={(e) => onChange(configKey, e.target.value)}
          placeholder={placeholder}
          type="password"
          value={value}
        />
        {(isEditing || hasNewValue) && (
          <Button
            onClick={() => {
              onChange(configKey, "");
              setIsEditing(false);
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
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

function OAuthManagedCredentialField({
  label,
  providerLabel,
}: {
  label: string;
  providerLabel: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/30 px-3">
        <Check aria-hidden="true" className="size-4 text-success" />
        <span className="text-muted-foreground text-sm">
          Managed by {providerLabel} OAuth
        </span>
      </div>
    </div>
  );
}

/**
 * Overlay for editing an existing connection
 */
export function EditConnectionOverlay({
  overlayId,
  integration,
  onSuccess,
  onDelete,
}: EditConnectionOverlayProps) {
  const { push, closeAll } = useOverlay();
  const queryClient = useQueryClient();
  const [name, setName] = useState(integration.name);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState(integration.oauth);
  const oauthConnection = useOAuthConnection({
    onConnected: () => {
      onSuccess?.();
      closeAll();
    },
  });
  const oauthPending = oauthConnection.pending;

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const update = useMutation(
    orpcQuery.integration.update.mutationOptions({
      onSuccess: async () => {
        toast.success("Connection updated");
        await refreshIntegrations(queryClient);
        onSuccess?.();
        closeAll();
      },
      meta: { errorMessage: "Failed to update connection" },
    })
  );

  // A test run as part of saving, whose failure is an offer to save anyway
  // rather than something to toast.
  const testForSave = useMutation(
    orpcQuery.integration.testConnection.mutationOptions({
      meta: { errorShownByCaller: true },
    })
  );

  const testStoredCredentials = useMutation(
    orpcQuery.integration.testConnection.mutationOptions({
      onSuccess: announceTestResult,
    })
  );

  const disconnectOAuth = useMutation(
    orpcQuery.integration.disconnectOAuth.mutationOptions({
      onSuccess: async () => {
        setOauth(undefined);
        toast.success("OAuth connection disconnected");
        await refreshIntegrations(queryClient);
      },
      meta: { errorMessage: "Failed to disconnect OAuth connection" },
    })
  );

  const catalog = useExtensionCatalog();
  const catalogEntry = findIntegration(catalog, integration.type);
  const formFields = catalogEntry?.credentialFields;
  // Whether this integration has a connection test at all. An integration that
  // declares none has nothing to press and nothing to run before a save.
  const hasTest = catalogEntry?.hasTest === true;

  const saving = update.isPending || testForSave.isPending;
  const testing = testStoredCredentials.isPending;
  const oauthBusy = oauthPending || disconnectOAuth.isPending;
  const controlsDisabled = saving || testing || oauthBusy;

  const saveConnection = () => {
    update.mutate({
      integrationId: integration.id,
      name: name.trim(),
      // Both fields are optional on the contract, so leaving the credentials out
      // is how "keep the stored ones" is said.
      config: hasProvidedConfigValues(config) ? config : undefined,
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
    const hasNewConfig = hasProvidedConfigValues(config);

    // Nothing new to test: either the credentials were left alone, in which case
    // only the label is being saved, or the integration declares no test.
    if (!(hasNewConfig && hasTest)) {
      saveConnection();
      return;
    }

    // Test before saving
    try {
      const result = await testForSave.mutateAsync({
        integrationId: integration.id,
        config: hasNewConfig ? config : undefined,
      });

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
    testStoredCredentials.mutate({
      integrationId: integration.id,
      config: hasProvidedConfigValues(config) ? config : undefined,
    });
  };

  const handleDelete = () => {
    push(DeleteConnectionOverlay, {
      integration,
      // This overlay is the connection just deleted, so it goes with the
      // confirmation rather than being revealed behind it.
      onDismiss: closeAll,
      onSuccess: onDelete,
    });
  };

  const handleOAuthConnect = async () => {
    await oauthConnection.startExisting(integration.id);
  };

  const renderConfigFields = () => {
    if (!formFields) {
      return null;
    }

    return Object.entries(formFields).map(([configKey, field]) => {
      const isOAuthManaged =
        (oauth?.status === "connected" ||
          oauth?.status === "reauthorization_required") &&
        oauth.credentialKeys.includes(configKey);

      if (isOAuthManaged) {
        return (
          <OAuthManagedCredentialField
            key={configKey}
            label={field.label}
            providerLabel={catalogEntry?.oauth?.label ?? integration.type}
          />
        );
      }

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
        {
          label: "Delete",
          variant: "ghost",
          onClick: handleDelete,
          disabled: controlsDisabled,
        },
        ...(hasTest
          ? [
              {
                label: "Test",
                variant: "outline" as const,
                onClick: handleTest,
                loading: testing,
                disabled: saving || oauthBusy,
              },
            ]
          : []),
        {
          label: "Update",
          onClick: handleSave,
          loading: saving,
          disabled: testing || oauthBusy,
        },
      ]}
      overlayId={overlayId}
      title={`Edit ${integrationLabel(catalogEntry, integration.type)}`}
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Update your connection credentials
      </p>

      <div className="space-y-4">
        {catalogEntry?.oauth && (
          <OAuthConnectionStatus
            oauth={oauth}
            onConnect={handleOAuthConnect}
            onDisconnect={() =>
              disconnectOAuth.mutate({ integrationId: integration.id })
            }
            pending={oauthBusy}
            providerLabel={catalogEntry.oauth.label}
          />
        )}
        <fieldset
          aria-busy={oauthBusy}
          className="m-0 min-w-0 space-y-4 border-0 p-0"
          disabled={oauthBusy}
        >
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
      </div>
    </Overlay>
  );
}

type DeleteConnectionOverlayProps = {
  overlayId: string;
  integration: Integration;
  /**
   * How much of the stack to close once the delete lands. Defaults to this
   * confirmation alone; a caller that pushed it over its own overlay closes
   * both, since what it reveals is the edit form for a deleted connection.
   */
  onDismiss?: () => void;
  /** Runs after the connection list has been refreshed. */
  onSuccess?: () => void;
};

/**
 * Overlay for deleting a connection with optional key revocation
 */
export function DeleteConnectionOverlay({
  overlayId,
  integration,
  onDismiss,
  onSuccess,
}: DeleteConnectionOverlayProps) {
  const { pop } = useOverlay();
  const dismiss = onDismiss ?? pop;
  const queryClient = useQueryClient();

  const deleteIntegration = useMutation(
    orpcQuery.integration.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("Connection deleted");
        // Dismissing is this overlay's own business, and it happens before the
        // refresh is awaited: that await is a round trip, and the screen behind
        // this confirmation is the edit form for the connection just deleted.
        // Leaving it to the onSuccess prop is how the Connections screen, which
        // passes one that only invalidates, kept the confirmation on screen
        // stuck in its loading state.
        dismiss();
        await refreshIntegrations(queryClient);
        onSuccess?.();
      },
      meta: { errorMessage: "Failed to delete connection" },
    })
  );

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: pop },
        {
          label: "Delete",
          variant: "destructive",
          onClick: () =>
            deleteIntegration.mutate({ integrationId: integration.id }),
          loading: deleteIntegration.isPending,
        },
      ]}
      overlayId={overlayId}
      title="Delete Connection"
    >
      <p className="text-muted-foreground text-sm">
        Are you sure you want to delete this connection? Workflows using it will
        fail until a new one is configured.
      </p>
    </Overlay>
  );
}
