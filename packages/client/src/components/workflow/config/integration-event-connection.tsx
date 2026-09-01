import { useQuery } from "@tanstack/react-query";
import { Button } from "#src/components/ui/button";
import { Label } from "#src/components/ui/label";
import { IntegrationSelector } from "#src/components/ui/integration-selector";
import { WebhookUrlField } from "#src/components/ui/webhook-url-field";
import { EditConnectionOverlay } from "#src/components/overlays/edit-connection-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useConnectionRepair } from "#src/hooks/use-connection-repair";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { can } from "#src/lib/authorization";
import {
  type ExtensionCatalog,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/**
 * One Connection for every Event of this integration on the node, plus the
 * webhook URL that Connection answers on.
 *
 * The URL is Connection-addressed, so Email sent and Email delivered paste the
 * same Resend endpoint. The signing secret lives on that Connection, not on
 * the workflow: Edit connection is how a builder pastes it after copying the
 * URL.
 */
export function IntegrationEventConnectionEditor({
  catalog,
  integrationType,
  connectionId,
  onChange,
  disabled,
}: {
  catalog: ExtensionCatalog;
  integrationType: string;
  connectionId: string | undefined;
  onChange: (connectionId: string) => void;
  disabled?: boolean;
}) {
  const entry = findIntegration(catalog, integrationType);
  const label = entry?.label ?? integrationType;
  const connection = useConnection(connectionId);

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-muted-foreground text-xs">
          {`${label} Connection`}
        </Label>
        <IntegrationSelector
          disabled={disabled}
          integrationType={integrationType}
          onChange={onChange}
          value={connectionId}
        />
      </div>
      {connectionId && entry?.hasWebhook ? (
        <WebhookConnectionDetails
          connection={connection}
          connectionId={connectionId}
          disabled={disabled}
          helpText={entry.webhookHelpText}
          secretKey={entry.webhookSecretKey}
          type={integrationType}
        />
      ) : null}
    </div>
  );
}

function useConnection(
  connectionId: string | undefined
): Integration | undefined {
  const { data: connections = [] } = useQuery({
    ...integrationsQueryOptions(),
    enabled: can(WfGraphOperations.integrationGetAll.id),
  });
  return connections.find((entry) => entry.id === connectionId);
}

function WebhookConnectionDetails({
  connectionId,
  type,
  helpText,
  secretKey,
  connection,
  disabled,
}: {
  connectionId: string;
  type: string;
  helpText?: string;
  secretKey?: string;
  connection: Integration | undefined;
  disabled?: boolean;
}) {
  const { push } = useOverlay();
  const repairAgainstConnectionList = useConnectionRepair();
  const hasSecret =
    secretKey !== undefined &&
    Boolean(connection?.configuredKeys.includes(secretKey));
  const urlHelpText =
    !hasSecret && secretKey && helpText
      ? `${helpText} Then add the signing secret from that page.`
      : helpText;

  return (
    <>
      <WebhookUrlField
        connectionId={connectionId}
        helpText={urlHelpText}
        type={type}
      />
      {connection && secretKey ? (
        <Button
          onClick={() =>
            push(EditConnectionOverlay, {
              integration: connection,
              onSuccess: repairAgainstConnectionList,
              onDelete: repairAgainstConnectionList,
            })
          }
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
        >
          {hasSecret ? "Edit connection" : "Add signing secret"}
        </Button>
      ) : null}
    </>
  );
}
