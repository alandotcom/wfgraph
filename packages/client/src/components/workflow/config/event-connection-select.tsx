import { IntegrationSelector } from "#src/components/ui/integration-selector";

/**
 * The Connection an integration-owned Event arrives through.
 *
 * Host Events never name one. The picker is the same control an action uses,
 * so adding a Connection here is the same flow as adding one on an action. One
 * picker per integration, not per Event: two Resend Events share this control.
 */
export function EventConnectionSelect({
  integrationType,
  value,
  onChange,
  disabled,
}: {
  integrationType: string;
  value: string | undefined;
  onChange: (connectionId: string) => void;
  disabled?: boolean;
}) {
  return (
    <IntegrationSelector
      disabled={disabled}
      integrationType={integrationType}
      onChange={onChange}
      value={value}
    />
  );
}
