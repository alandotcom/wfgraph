import { useQuery } from "@tanstack/react-query";
import { partition } from "es-toolkit/array";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { whenChosen } from "#src/lib/select-choice";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";

type IntegrationSelectorProps = {
  integrationType: string;
  value?: string;
  onChange: (integrationId: string) => void;
  disabled?: boolean;
};

/**
 * Which existing connection a node uses, and nothing else.
 *
 * Creating, editing and deleting a connection all live in Settings >
 * Connections, so a node's configuration panel never manages the list it reads
 * from. That is also why nothing here refreshes the graph after a write: the
 * repair belongs to the surface that changes the list.
 */
export function IntegrationSelector({
  integrationType,
  value,
  onChange,
  disabled,
}: IntegrationSelectorProps) {
  const catalog = useExtensionCatalog();
  const { data: allIntegrations = [], isPending } = useQuery(
    integrationsQueryOptions()
  );

  const integrations = useMemo(
    () => allIntegrations.filter((i) => i.type === integrationType),
    [allIntegrations, integrationType]
  );

  const catalogEntry = findIntegration(catalog, integrationType);
  const integrationLabel = catalogEntry?.label || integrationType;
  const nameOf = (integration: Integration) =>
    integration.name || `${integrationLabel} API Key`;

  // isPending is false the moment the cache holds anything, so a second
  // selector mounting alongside the first shows the list rather than a skeleton.
  if (isPending) {
    return (
      <div
        aria-busy="true"
        className="h-7 w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none"
      />
    );
  }

  if (integrations.length === 0) {
    return (
      <div className="space-y-1">
        <Select disabled items={[]} value={null}>
          <SelectTrigger aria-label={`${integrationLabel} connection`} className="w-full">
            <SelectValue placeholder="No connection" />
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p className="text-muted-foreground text-xs">
          {`Add a ${integrationLabel} connection in Settings > Connections.`}
        </p>
      </div>
    );
  }

  // Managed connections come first, which is the only thing the split decides.
  const [managed, manual] = partition(integrations, (i) => Boolean(i.isManaged));
  const items = [...managed, ...manual].map((integration) => ({
    label: nameOf(integration),
    value: integration.id,
  }));

  return (
    <Select
      disabled={disabled}
      items={items}
      onValueChange={whenChosen(onChange)}
      value={value ?? null}
    >
      <SelectTrigger
        aria-label={`${integrationLabel} connection`}
        className="w-full"
      >
        <SelectValue placeholder="Choose a connection" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
