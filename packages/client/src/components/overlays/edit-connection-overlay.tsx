import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link, Pencil, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { WebhookUrlField } from "#src/components/ui/webhook-url-field";
import { can } from "#src/lib/authorization";
import type { Integration } from "#src/lib/rpc-client";
import {
  integrationsQueryOptions,
  orpcQuery,
  refreshIntegrations,
} from "#src/lib/rpc-query";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  findIntegration,
  type CredentialFieldMetadata,
  type IntegrationMetadata,
} from "@wfgraph/shared/extensions/catalog";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

/** An integration's label, falling back to its type when the catalog lacks it. */
const integrationLabel = (
  entry: IntegrationMetadata | undefined,
  type: string
): string => entry?.label ?? type;

/**
 * One panel for every state an OAuth connection can be in.
 *
 * The three states differ in their icon, their heading, what they say underneath
 * and which buttons they offer, and in nothing else. They were three copies of
 * the same section, which is three places to keep an `aria-busy`, a label and a
 * layout in step, so the shell lives here once and each state supplies only its
 * own parts.
 */
function OAuthStatusPanel({
  providerLabel,
  pending,
  icon,
  title,
  actions,
  children,
}: {
  providerLabel: string;
  pending: boolean;
  icon: ReactNode;
  title: string;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      aria-busy={pending}
      aria-label={`${providerLabel} OAuth connection`}
      className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2" role="status">
        {icon}
        <div className="space-y-0.5 text-sm">
          <p className="font-medium">{title}</p>
          {children}
        </div>
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </section>
  );
}

/**
 * The state a connection is in before OAuth has ever run, and the one it returns
 * to after a disconnect. This is the only offer of the OAuth flow for a saved
 * connection, so it stays reachable whenever the catalog declares a provider.
 */
function OAuthConnectPrompt({
  providerLabel,
  pending,
  canConnect,
  onConnect,
}: {
  providerLabel: string;
  pending: boolean;
  canConnect: boolean;
  onConnect: () => void;
}) {
  return (
    <OAuthStatusPanel
      actions={
        canConnect ? (
          <Button disabled={pending} onClick={onConnect} type="button">
            Connect
          </Button>
        ) : null
      }
      icon={<Link aria-hidden="true" className="mt-0.5 size-4" />}
      pending={pending}
      providerLabel={providerLabel}
      title="Disconnected"
    >
      <p className="text-muted-foreground">
        Connect {providerLabel} to authorize this connection.
      </p>
    </OAuthStatusPanel>
  );
}

function OAuthConnectionStatus({
  oauth,
  providerLabel,
  pending,
  canConnect,
  canDisconnect,
  onConnect,
  onDisconnect,
}: {
  oauth: NonNullable<Integration["oauth"]>;
  providerLabel: string;
  pending: boolean;
  canConnect: boolean;
  canDisconnect: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (oauth.status === "connected") {
    return (
      <OAuthStatusPanel
        actions={
          <>
            {canConnect ? (
              <Button
                disabled={pending}
                onClick={onConnect}
                title={`Reconnect to change what ${providerLabel} allows`}
                type="button"
                variant="outline"
              >
                Reconnect
              </Button>
            ) : null}
            {canDisconnect ? (
              <Button
                disabled={pending}
                onClick={onDisconnect}
                type="button"
                variant="outline"
              >
                Disconnect
              </Button>
            ) : null}
          </>
        }
        icon={
          <Check aria-hidden="true" className="mt-0.5 size-4 text-success" />
        }
        pending={pending}
        providerLabel={providerLabel}
        title="Connected"
      >
        {oauth.accountLabel && (
          <p className="text-muted-foreground">Account: {oauth.accountLabel}</p>
        )}
        {/*
          What the provider granted, in its own words. Read-only, because
          access is changed at the provider's consent page and nowhere else:
          Reconnect is the control, and this line is the current state.
        */}
        {oauth.grantedAccessLabel && (
          <p className="text-muted-foreground">
            Access: {oauth.grantedAccessLabel}
          </p>
        )}
        <p className="text-muted-foreground">
          Connected on {oauth.connectedAt.slice(0, 10)}
        </p>
      </OAuthStatusPanel>
    );
  }

  return (
    <OAuthStatusPanel
      actions={
        canConnect ? (
          <Button disabled={pending} onClick={onConnect} type="button">
            Reconnect
          </Button>
        ) : null
      }
      icon={
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 text-warning"
        />
      }
      pending={pending}
      providerLabel={providerLabel}
      title="Reauthorization required"
    >
      <p className="text-muted-foreground">
        Reconnect {providerLabel} to continue using this connection.
      </p>
    </OAuthStatusPanel>
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
  configured,
  value,
  onChange,
}: {
  fieldId: string;
  label: string;
  configKey: string;
  placeholder?: string;
  helpText?: string;
  helpLink?: { url: string; text: string };
  configured: boolean;
  value: string;
  onChange: (key: string, value: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const isMobile = useIsMobile();
  const hasNewValue = value.length > 0;

  if (configured && !(isEditing || hasNewValue)) {
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{label}</Label>
        <div className="flex items-center gap-2">
          <div className="flex h-7 flex-1 items-center gap-2 rounded-md border bg-muted/30 px-2">
            <Check className="size-3.5 text-success" />
            <span className="text-muted-foreground text-xs/relaxed">
              Configured
            </span>
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
      <div className="flex h-7 items-center gap-2 rounded-md border bg-muted/30 px-2">
        <Check aria-hidden="true" className="size-3.5 text-success" />
        <span className="text-muted-foreground text-xs/relaxed">
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
  const canRead = can(WfGraphOperations.integrationGetAll.id);
  const canUpdate = can(WfGraphOperations.integrationUpdate.id);
  const canDelete = can(WfGraphOperations.integrationDelete.id);
  const canTest = can(WfGraphOperations.integrationTestConnection.id);
  const canDisconnect = can(WfGraphOperations.integrationDisconnectOAuth.id);
  const [name, setName] = useState(integration.name);
  const [config, setConfig] = useState<Record<string, string>>({});
  const { data: integrations } = useQuery({
    ...integrationsQueryOptions(),
    enabled: canRead,
  });
  const oauth =
    integrations === undefined
      ? integration.oauth
      : integrations.find(({ id }) => id === integration.id)?.oauth;
  // The keys the operator entered themselves. Disconnecting OAuth leaves them
  // alone, so this stays true for the life of the overlay.
  const configuredKeys = new Set(integration.configuredKeys);
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
        await refreshIntegrations(queryClient, integration.id);
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
      onSuccess: async (result) => {
        await refreshIntegrations(queryClient, integration.id);
        if (result.removed) {
          // The grant was the whole connection, so there is no longer one to
          // edit. Take the delete path: it repairs the nodes that named it.
          toast.success("Connection removed");
          onDelete?.();
          closeAll();
          return;
        }
        toast.success("OAuth connection disconnected");
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
    if (!canUpdate) {
      return;
    }
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
    if (!canUpdate) {
      return;
    }
    const hasNewConfig = hasProvidedConfigValues(config);

    // Nothing new to test: either the credentials were left alone, in which case
    // only the label is being saved, or the integration declares no test.
    if (!(hasNewConfig && hasTest && canTest)) {
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
    if (!canTest) {
      return;
    }
    testStoredCredentials.mutate({
      integrationId: integration.id,
      config: hasProvidedConfigValues(config) ? config : undefined,
    });
  };

  const handleDelete = () => {
    if (!canDelete) {
      return;
    }
    push(DeleteConnectionOverlay, {
      integration,
      // This overlay is the connection just deleted, so it goes with the
      // confirmation rather than being revealed behind it.
      onDismiss: closeAll,
      onSuccess: onDelete,
    });
  };

  const handleOAuthConnect = async () => {
    if (!oauthConnection.canStart) {
      return;
    }
    await oauthConnection.startExisting(integration.id);
  };

  /**
   * Disconnecting revokes the grant at the provider, which this app cannot undo,
   * and when the grant was the only credential it takes the connection with it.
   * So it asks first, and it says which of the two is about to happen: the
   * server already told us, in `configuredKeys`, whether anything the operator
   * typed themselves would survive.
   */
  const handleOAuthDisconnect = () => {
    if (!canDisconnect) {
      return;
    }
    const grantIsWholeConnection = configuredKeys.size === 0;
    const providerLabel = catalogEntry?.oauth?.label ?? integration.type;

    push(ConfirmOverlay, {
      title: grantIsWholeConnection
        ? "Remove this connection"
        : `Disconnect ${providerLabel}`,
      message: grantIsWholeConnection
        ? `${providerLabel} access is the only credential "${integration.name}" holds, so disconnecting removes the connection itself. Workflows using it will fail until a new one is configured.\n\nThis also revokes the authorization at ${providerLabel}, which cannot be undone from here.`
        : `This revokes the authorization at ${providerLabel}, which cannot be undone from here. The credentials you entered yourself are kept, so "${integration.name}" stays available.`,
      // Named rather than a bare "Disconnect", which is what the button behind
      // this dialog already says: the confirming click should read differently
      // from the one that opened it.
      confirmLabel: grantIsWholeConnection
        ? "Remove connection"
        : `Disconnect ${providerLabel}`,
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: () => {
        if (canDisconnect) {
          disconnectOAuth.mutate({ integrationId: integration.id });
        }
      },
    });
  };

  const renderConfigFields = (
    entries: readonly (readonly [string, CredentialFieldMetadata])[]
  ) => {
    return entries.map(([configKey, field]) => {
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
            configured={configuredKeys.has(configKey)}
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

  const credentialEntries = Object.entries(formFields ?? {});

  return (
    <Overlay
      actions={[
        ...(canDelete
          ? [
              {
                label: "Delete",
                variant: "ghost" as const,
                onClick: handleDelete,
                disabled: controlsDisabled,
              },
            ]
          : []),
        ...(hasTest && canTest
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
        ...(canUpdate
          ? [
              {
                label: "Update",
                onClick: handleSave,
                loading: saving,
                disabled: testing || oauthBusy,
              },
            ]
          : []),
      ]}
      overlayId={overlayId}
      title={`Edit ${integrationLabel(catalogEntry, integration.type)}`}
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Update your connection credentials
      </p>

      <div className="space-y-4">
        {catalogEntry?.oauth &&
          (oauth ? (
            <OAuthConnectionStatus
              oauth={oauth}
              canConnect={oauthConnection.canStart}
              canDisconnect={canDisconnect}
              onConnect={handleOAuthConnect}
              onDisconnect={handleOAuthDisconnect}
              pending={oauthBusy}
              providerLabel={catalogEntry.oauth.label}
            />
          ) : (
            <OAuthConnectPrompt
              canConnect={oauthConnection.canStart}
              onConnect={handleOAuthConnect}
              pending={oauthBusy}
              providerLabel={catalogEntry.oauth.label}
            />
          ))}
        <fieldset
          aria-busy={oauthBusy}
          className="m-0 min-w-0 space-y-4 border-0 p-0"
          disabled={oauthBusy || !canUpdate}
        >
          {catalogEntry?.hasWebhook ? (
            <WebhookUrlField
              connectionId={integration.id}
              helpText={catalogEntry.webhookHelpText}
              type={integration.type}
            />
          ) : null}

          {renderConfigFields(credentialEntries)}

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
   * both, because what it reveals is the edit form for a deleted connection.
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
  const canDelete = can(WfGraphOperations.integrationDelete.id);

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
        await refreshIntegrations(queryClient, integration.id);
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
          onClick: () => {
            if (canDelete) {
              deleteIntegration.mutate({ integrationId: integration.id });
            }
          },
          disabled: !canDelete,
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
