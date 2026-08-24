import { getBasePath } from "#src/lib/base-path";
import { ApiError } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";

const OAUTH_POLL_INTERVAL_MS = 1_000;
const OAUTH_POLL_TIMEOUT_MS = 10 * 60_000;
const CLOSED_POPUP_FINAL_POLLS = 3;

type OAuthStatus = "connected" | "reauthorization_required";

type OAuthSummary = {
  id: string;
  oauth?: {
    status: OAuthStatus;
    connectedAt: string;
    accountLabel?: string;
  };
};

type OAuthPopup = Pick<Window, "closed" | "close"> & {
  location: Pick<Location, "assign">;
  opener: Window | null;
};

type OAuthPollingResult =
  | { status: OAuthStatus; integration: OAuthSummary }
  | { status: "pending" };

type Sleep = (milliseconds: number) => Promise<void>;

type OAuthPollingQueryClient = {
  fetchQuery: (
    options: ReturnType<typeof integrationsQueryOptions> & { staleTime: number }
  ) => Promise<readonly OAuthSummary[]>;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function integrationOAuthPath(integrationId: string): string {
  return `${getBasePath()}/api/integrations/${encodeURIComponent(integrationId)}/oauth`;
}

/** Builds the authenticated direct route used to revoke one OAuth grant. */
export function integrationOAuthUrl(integrationId: string): string {
  return integrationOAuthPath(integrationId);
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

function navigateOAuthPopup(popup: OAuthPopup, integrationId: string): void {
  popup.location.assign(integrationOAuthStartUrl(integrationId));
}

/**
 * Reserves a popup while the browser still treats the click as a user gesture,
 * then creates the row before the popup is sent to the provider.
 */
export async function beginCreatedOAuthConnection({
  create,
}: {
  create: () => Promise<{ id: string }>;
}): Promise<
  | { status: "popup_blocked" }
  | { status: "started"; integrationId: string; popup: OAuthPopup }
> {
  const popup = reserveOAuthPopup();
  if (!popup) {
    return { status: "popup_blocked" };
  }

  try {
    const integration = await create();
    navigateOAuthPopup(popup, integration.id);
    return { status: "started", integrationId: integration.id, popup };
  } catch (error) {
    popup.close();
    throw error;
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

  navigateOAuthPopup(popup, integrationId);
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
}: {
  baseline?: OAuthSummary["oauth"];
  integrationId: string;
  popup: Pick<OAuthPopup, "closed">;
  queryClient: OAuthPollingQueryClient;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: Sleep;
  now?: () => number;
}): Promise<OAuthPollingResult> {
  const startedAt = now();
  const poll = async (
    closedPopupPolls: number
  ): Promise<OAuthPollingResult> => {
    if (now() - startedAt >= timeoutMs) {
      return { status: "pending" };
    }

    const integrations = await queryClient.fetchQuery({
      ...integrationsQueryOptions(),
      staleTime: 0,
    });
    const integration = integrations.find(({ id }) => id === integrationId);

    const oauth = integration?.oauth;
    if (oauth) {
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
      const finalPolls = closedPopupPolls + 1;
      if (finalPolls >= CLOSED_POPUP_FINAL_POLLS) {
        return { status: "pending" };
      }
      await wait(intervalMs);
      return poll(finalPolls);
    }

    await wait(intervalMs);
    return poll(0);
  };

  return poll(0);
}

/**
 * Calls a direct authenticated API route and turns every non-success response
 * into the same `ApiError` shape mutations already surface through toasts.
 */
export async function requestApiRoute(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const response = await globalThis.fetch(path, init);
  if (response.ok) {
    return response;
  }

  const body = await response.text();
  let message = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      message = parsed.error;
    }
  } catch {
    // Plain-text proxies still give the operator a useful server response.
  }

  throw new ApiError(response.status, message || "OAuth request failed");
}
