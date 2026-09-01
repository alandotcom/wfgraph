import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useUnmountCleanup } from "#src/hooks/effects";
import {
  type NewOAuthConnectionInput,
  type OAuthPopup,
  type OAuthStartInput,
  pollOAuthAttempt,
  reserveOAuthPopup,
  startOAuthConnection,
} from "#src/lib/oauth-connection";
import { can } from "#src/lib/authorization";
import { refreshIntegrations } from "#src/lib/rpc-query";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

type ActiveAttempt = {
  controller: AbortController;
  popup: OAuthPopup;
};

type OAuthConnectionControllerOptions = {
  onConnected: (integrationId: string) => void;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Owns one popup, status poll, cache refresh, and cancellation lifecycle. */
export function useOAuthConnection({
  onConnected,
}: OAuthConnectionControllerOptions): {
  pending: boolean;
  canStart: boolean;
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
    try {
      attempt?.popup.close();
    } catch {
      // Cross-Origin-Opener-Policy on the provider page can make the handle
      // unusable once that page has loaded.
    }
    if (updateState) {
      setPending(false);
    }
  };

  useUnmountCleanup(() => cancel(false));

  const run = async (input: OAuthStartInput) => {
    if (
      !can(WfGraphOperations.oauthStart.id) ||
      !can(WfGraphOperations.oauthStatus.id) ||
      !can(WfGraphOperations.oauthCallback.id)
    ) {
      return;
    }
    cancel(false);
    const popup = reserveOAuthPopup();
    if (!popup) {
      setPending(false);
      toast.error("Allow pop-ups to connect this provider");
      return;
    }

    // The hook owns the popup before the first await. Cancellation can now
    // always close it, including while the start request is in flight.
    const attempt: ActiveAttempt = {
      controller: new AbortController(),
      popup,
    };
    activeAttempt.current = attempt;
    setPending(true);
    let authorizationStarted = false;

    try {
      const authorization = await startOAuthConnection(
        input,
        attempt.controller.signal
      );
      if (activeAttempt.current !== attempt) {
        return;
      }

      authorizationStarted = true;
      popup.location.assign(authorization.authorizeUrl);
      const result = await pollOAuthAttempt({
        attemptId: authorization.attemptId,
        signal: attempt.controller.signal,
      });
      if (activeAttempt.current !== attempt) {
        return;
      }

      // A timeout is not the server's verdict, so nothing has changed and
      // there is nothing to refresh. Closing the overlay aborts instead of
      // treating a severed popup handle as a cancelled authorization.
      if (result.status === "timed_out") {
        toast.error("Authorization timed out. Try connecting again.");
        return;
      }

      // A terminal status may have changed the integration even on failure, so
      // refresh once before announcing or closing any surface that reads it.
      await refreshIntegrations(
        queryClient,
        result.status === "succeeded"
          ? result.integrationId
          : input.mode === "reconnect"
            ? input.integrationId
            : undefined
      );
      if (activeAttempt.current !== attempt) {
        return;
      }

      if (result.status === "succeeded") {
        toast.success("Connection authorized");
        onConnected(result.integrationId);
      } else {
        toast.error("Could not complete OAuth authorization");
      }
    } catch (error) {
      if (activeAttempt.current === attempt && !isAbortError(error)) {
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
    canStart:
      can(WfGraphOperations.oauthStart.id) &&
      can(WfGraphOperations.oauthStatus.id) &&
      can(WfGraphOperations.oauthCallback.id),
    startCreated: (input) => run({ mode: "create", ...input }),
    startExisting: (integrationId) => run({ mode: "reconnect", integrationId }),
  };
}
