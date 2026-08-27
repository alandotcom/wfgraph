/**
 * Why a provider-backed field is drawing its plain control instead.
 *
 * Whatever this says, the control beneath it stays live. That is the invariant
 * the two provider fields share: a builder is never stuck because a connection
 * is missing, a grant is too narrow, or the provider is down, because they can
 * always type the value themselves.
 */

import { Button } from "#src/components/ui/button";
import { WarningCallout } from "#src/components/ui/callout";
import type { ConfigOptionsState } from "./use-config-options";

export function ProviderFieldNotice({ state }: { state: ConfigOptionsState }) {
  if (state.state === "unavailable") {
    // The integration wrote this sentence, and it is the one that says what to
    // do about a grant too narrow to read what the field needs.
    return <WarningCallout className="text-xs">{state.message}</WarningCallout>;
  }

  if (state.state === "failed") {
    // Deliberately fixed wording. The only message available is the vendor
    // exception the request failed with, which nobody audited and which can
    // carry a request URL holding a credential.
    return (
      <WarningCallout className="text-xs">
        <span className="block">Could not read this from the connection.</span>
        <Button
          className="mt-1 h-7 px-2"
          onClick={state.retry}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      </WarningCallout>
    );
  }

  return null;
}
