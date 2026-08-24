import { getBasePath } from "#src/lib/base-path";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import { ApiError } from "#src/lib/rpc-client";
import { readJsonObject } from "@wfgraph/shared/types/json";

const OAUTH_POLL_INTERVAL_MS = 1_000;
const OAUTH_POLL_TIMEOUT_MS = 10 * 60_000;
const CLOSED_POPUP_FINAL_POLLS = 3;

type OAuthStatus = "connected" | "reauthorization_required";

export type OAuthSummary = {
  id: string;
  oauth?: {
    status: OAuthStatus;
    connectedAt: string;
    accountLabel?: string;
  };
};

export type OAuthPopup = Pick<Window, "closed" | "close"> & {
  location: Pick<Location, "assign">;
  opener: Window | null;
};

export type OAuthPollingResult =
  | { status: OAuthStatus; integration: OAuthSummary }
  | { status: "pending" };

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

type OAuthPollingQueryClient = {
  fetchQuery: (
    options: ReturnType<typeof integrationsQueryOptions> & { staleTime: number }
  ) => Promise<readonly OAuthSummary[]>;
};

function abortError(): DOMException {
  return new DOMException("The OAuth authorization was canceled", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitUnlessAborted(
  pending: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    return pending;
  }
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function integrationOAuthPath(integrationId: string): string {
  return `${getBasePath()}/api/integrations/${encodeURIComponent(integrationId)}/oauth`;
}

export type NewOAuthConnectionInput = {
  name: string;
  type: string;
  config: Record<string, string>;
};

type NewOAuthAuthorization = {
  integrationId: string;
  authorizeUrl: string;
};

/** Starts a create-mode attempt without creating an integration row. */
export async function startNewOAuthConnection(
  input: NewOAuthConnectionInput,
  signal?: AbortSignal
): Promise<NewOAuthAuthorization> {
  const response = await fetch(
    `${getBasePath()}/api/integrations/oauth/start`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    }
  );
  const body = readJsonObject(await response.json().catch(() => null));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body?.error === "string"
        ? body.error
        : "Failed to start OAuth authorization"
    );
  }
  if (
    typeof body?.integrationId !== "string" ||
    typeof body.authorizeUrl !== "string"
  ) {
    throw new ApiError(500, "OAuth start returned an invalid response");
  }
  return {
    integrationId: body.integrationId,
    authorizeUrl: body.authorizeUrl,
  };
}

/** Builds the provider redirect route for an OAuth connection. */
export function integrationOAuthStartUrl(integrationId: string): string {
  return `${integrationOAuthPath(integrationId)}/start`;
}

function reserveOAuthPopup(): OAuthPopup | null {
  const popup = window.open("", "_blank", "popup");
  if (popup) {
    // The flow communicates through server state, so the provider never needs a
    // live handle that could navigate the editor tab.
    popup.opener = null;
  }
  return popup;
}

/**
 * Reserves a popup while the browser still treats the click as a user gesture,
 * then creates the server-owned attempt before navigating to the provider.
 */
export async function beginCreatedOAuthConnection({
  start,
  signal,
}: {
  start: () => Promise<NewOAuthAuthorization>;
  signal?: AbortSignal;
}): Promise<
  | { status: "popup_blocked" }
  | { status: "started"; integrationId: string; popup: OAuthPopup }
> {
  const popup = reserveOAuthPopup();
  if (!popup) {
    return { status: "popup_blocked" };
  }

  const closeOnAbort = () => popup.close();
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    throwIfAborted(signal);
    const authorization = await start();
    throwIfAborted(signal);
    popup.location.assign(authorization.authorizeUrl);
    return {
      status: "started",
      integrationId: authorization.integrationId,
      popup,
    };
  } catch (error) {
    popup.close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
  }
}

/** Opens the provider for an existing row while the click still owns the popup. */
export function beginExistingOAuthConnection(
  integrationId: string
): { status: "popup_blocked" } | { status: "started"; popup: OAuthPopup } {
  const popup = reserveOAuthPopup();
  if (!popup) {
    return { status: "popup_blocked" };
  }

  popup.location.assign(integrationOAuthStartUrl(integrationId));
  return { status: "started", popup };
}

/**
 * Reads an OAuth result through the same list cache every selector uses. A
 * changed summary counts only after the reserved popup closes. A closed popup
 * gets a few final reads because the provider callback can finish just after
 * the browser removes its window. A baseline keeps a reconnect from treating
 * its existing summary as the result; connected grants must change
 * `connectedAt`, while a changed terminal status is enough for other results.
 */
export async function pollOAuthConnection({
  baseline,
  integrationId,
  popup,
  queryClient,
  intervalMs = OAUTH_POLL_INTERVAL_MS,
  timeoutMs = OAUTH_POLL_TIMEOUT_MS,
  sleep: wait = sleep,
  now = Date.now,
  signal,
}: {
  baseline?: OAuthSummary["oauth"];
  integrationId: string;
  popup: Pick<OAuthPopup, "closed">;
  queryClient: OAuthPollingQueryClient;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: Sleep;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<OAuthPollingResult> {
  const startedAt = now();
  let closedPopupPolls = 0;
  let lastReauthorization: OAuthSummary | undefined;

  while (true) {
    throwIfAborted(signal);
    if (now() - startedAt >= timeoutMs) {
      return { status: "pending" };
    }

    // eslint-disable-next-line no-await-in-loop -- each poll must observe the response before scheduling the next one.
    const integrations = await queryClient.fetchQuery({
      ...integrationsQueryOptions(),
      staleTime: 0,
    });
    throwIfAborted(signal);
    const integration = integrations.find(({ id }) => id === integrationId);

    const oauth = integration?.oauth;
    if (oauth) {
      if (oauth.status === "reauthorization_required") {
        lastReauthorization = integration;
      }
      const isNewConnectedGrant =
        oauth.status === "connected" &&
        (!baseline || oauth.connectedAt !== baseline.connectedAt);
      const isChangedTerminalResult =
        oauth.status !== "connected" &&
        (!baseline || oauth.status !== baseline.status);

      if (popup.closed && (isNewConnectedGrant || isChangedTerminalResult)) {
        return { status: oauth.status, integration };
      }
    }

    if (popup.closed) {
      closedPopupPolls += 1;
      if (closedPopupPolls >= CLOSED_POPUP_FINAL_POLLS) {
        if (lastReauthorization?.oauth?.status === "reauthorization_required") {
          return {
            status: "reauthorization_required",
            integration: lastReauthorization,
          };
        }
        return { status: "pending" };
      }
    } else {
      closedPopupPolls = 0;
    }

    // eslint-disable-next-line no-await-in-loop -- OAuth polls are intentionally sequential and separated by this delay.
    await waitUnlessAborted(wait(intervalMs, signal), signal);
    throwIfAborted(signal);
  }
}
