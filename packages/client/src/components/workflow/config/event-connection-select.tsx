import { IntegrationSelector } from "#src/components/ui/integration-selector";
import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";

/**
 * The Connection an integration-owned Event arrives through.
 *
 * Host Events never name one. The picker is the same control an action uses,
 * so adding a Connection here is the same flow as adding one on an action.
 */
export function EventConnectionSelect({
  catalog,
  eventName,
  value,
  onChange,
  disabled,
}: {
  catalog: ExtensionCatalog;
  eventName: string;
  value: string | undefined;
  onChange: (connectionId: string) => void;
  disabled?: boolean;
}) {
  const event = findEvent(catalog, eventName);
  if (!event?.integration) {
    return null;
  }

  return (
    <IntegrationSelector
      disabled={disabled}
      integrationType={event.integration}
      onChange={onChange}
      value={value}
    />
  );
}
