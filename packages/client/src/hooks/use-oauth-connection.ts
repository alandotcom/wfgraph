import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useUnmountCleanup } from "#src/hooks/effects";
import {
  beginCreatedOAuthConnection,
  beginExistingOAuthConnection,
  type NewOAuthConnectionInput,
  type OAuthPopup,
  type OAuthSummary,
  pollOAuthConnection,
  startNewOAuthConnection,
} from "#src/lib/oauth-connection";
import { refreshIntegrations } from "#src/lib/rpc-query";

type ActiveAttempt = {
  controller: AbortController;
  popup?: OAuthPopup;
};

type OAuthConnectionControllerOptions = {
  baseline?: OAuthSummary["oauth"];
  onConnected: (integration: OAuthSummary) => void;
  onReauthorizationRequired?: (integration: OAuthSummary) => void;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Owns one popup, poll, cache refresh, and cancellation lifecycle. */
export function useOAuthConnection({
  baseline,
  onConnected,
  onReauthorizationRequired,
}: OAuthConnectionControllerOptions): {
  pending: boolean;
  startCreated: (input: NewOAuthConnectionInput) => Promise<void>;
  startExisting: (integrationId: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const activeAttempt = useRef<ActiveAttempt | null>(null);

  const cancel = (updateState: boolean) => {
    const attempt = activeAttempt.current;
    activeAttempt.current = null;
    attempt?.controller.abort();
    if (attempt?.popup && !attempt.popup.closed) {
      attempt.popup.close();
    }
    if (updateState) {
      setPending(false);
    }
  };

  useUnmountCleanup(() => cancel(false));

  const run = async (
    begin: (
      attempt: ActiveAttempt
    ) =>
      | ReturnType<typeof beginExistingOAuthConnection>
      | Promise<Awaited<ReturnType<typeof beginCreatedOAuthConnection>>>
  ) => {
    cancel(false);
    const attempt: ActiveAttempt = {
      controller: new AbortController(),
    };
    activeAttempt.current = attempt;
    setPending(true);
    let authorizationStarted = false;

    try {
      const started = await begin(attempt);
      if (activeAttempt.current !== attempt) {
        return;
      }
      if (started.status === "popup_blocked") {
        toast.error("Allow pop-ups to connect this provider");
        return;
      }

      authorizationStarted = true;
      attempt.popup = started.popup;
      const integrationId =
        "integrationId" in started ? started.integrationId : undefined;
      if (!integrationId) {
        throw new Error("OAuth connection id was not provided");
      }

      const result = await pollOAuthConnection({
        baseline,
        integrationId,
        popup: started.popup,
        queryClient,
        signal: attempt.controller.signal,
      });
      await refreshIntegrations(queryClient);
      if (activeAttempt.current !== attempt) {
        return;
      }

      if (result.status === "connected") {
        onConnected(result.integration);
        toast.success("Connection authorized");
      } else if (result.status === "reauthorization_required") {
        onReauthorizationRequired?.(result.integration);
        toast.error("Authorization needs to be completed again");
      } else {
        toast.message("Authorization is still pending");
      }
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(
          authorizationStarted
            ? "Could not check OAuth authorization"
            : "Could not start OAuth authorization"
        );
      }
    } finally {
      if (activeAttempt.current === attempt) {
        cancel(true);
      }
    }
  };

  return {
    pending,
    startCreated: (input) =>
      run((attempt) =>
        beginCreatedOAuthConnection({
          start: () =>
            startNewOAuthConnection(input, attempt.controller.signal),
          signal: attempt.controller.signal,
        })
      ),
    startExisting: (integrationId) =>
      run(() => {
        const started = beginExistingOAuthConnection(integrationId);
        return started.status === "started"
          ? { ...started, integrationId }
          : started;
      }),
  };
}
