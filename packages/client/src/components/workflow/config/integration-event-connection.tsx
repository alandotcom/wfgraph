import { useQuery } from "@tanstack/react-query";
import { Label } from "#src/components/ui/label";
import { WebhookUrlField } from "#src/components/ui/webhook-url-field";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import {
  type ExtensionCatalog,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import { EventConnectionSelect } from "./event-connection-select";

/**
 * One Connection for every Event of this integration on the node, plus the
 * webhook URL that Connection answers on.
 *
 * The URL is Connection-addressed, so Email sent and Email delivered paste the
 * same Resend endpoint. Showing it here is what makes the Events usable: the
 * vendor settings page is where the builder leaves the editor.
 */
export function IntegrationEventConnection({
  catalog,
  integrationType,
  connectionId,
  onChange,
  disabled,
  editing,
}: {
  catalog: ExtensionCatalog;
  integrationType: string;
  connectionId: string | undefined;
  onChange: (connectionId: string) => void;
  disabled?: boolean;
  editing: boolean;
}) {
  const entry = findIntegration(catalog, integrationType);
  const label = entry?.label ?? integrationType;

  return (
    <div className="space-y-2">
      {editing ? (
        <div className="space-y-1">
          <Label className="text-muted-foreground text-xs">
            {`${label} Connection`}
          </Label>
          <EventConnectionSelect
            disabled={disabled}
            integrationType={integrationType}
            onChange={onChange}
            value={connectionId}
          />
        </div>
      ) : connectionId ? (
        <ConnectionName connectionId={connectionId} integrationLabel={label} />
      ) : null}
      {connectionId && entry?.hasWebhook ? (
        <WebhookUrlField
          connectionId={connectionId}
          helpText={entry.webhookHelpText}
          type={integrationType}
        />
      ) : null}
    </div>
  );
}

function ConnectionName({
  connectionId,
  integrationLabel,
}: {
  connectionId: string;
  integrationLabel: string;
}) {
  const { data: connections = [] } = useQuery(integrationsQueryOptions());
  const connection = connections.find((entry) => entry.id === connectionId);
  const name = connection?.name || `${integrationLabel} API Key`;

  return (
    <p className="text-muted-foreground text-xs">
      {"via "}
      <span>{name}</span>
    </p>
  );
}
