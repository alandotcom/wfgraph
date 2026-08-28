import { getBasePath } from "#src/lib/base-path";
import { ApiError } from "#src/lib/rpc-client";
import { readJsonObject } from "@wfgraph/shared/types/json";

const OAUTH_POLL_INTERVAL_MS = 1_000;
const OAUTH_POLL_TIMEOUT_MS = 10 * 60_000;
const CLOSED_POPUP_FINAL_POLLS = 3;

export type NewOAuthConnectionInput = {
  name: string;
  type: string;
  config: Record<string, string>;
};

export type OAuthStartInput =
  | ({ mode: "create" } & NewOAuthConnectionInput)
  | { mode: "reconnect"; integrationId: string };

export type OAuthAuthorization = {
  attemptId: string;
  authorizeUrl: string;
};

export type OAuthAttemptStatus =
  | { status: "pending" }
  | { status: "succeeded"; integrationId: string }
  | { status: "failed" };

/**
 * How a poll ended, which the server's own `pending` cannot say.
 *
 * The two terminal statuses are the server's verdict and travel through
 * unchanged. The other two are this loop's: the attempt is still open at the
 * server in both cases, and they are kept apart because the sentence a person
 * needs is different. `timed_out` means nobody finished the authorization inside
 * the window; `abandoned` means the popup went away while it was still pending,
 * which is what closing it looks like from here.
 */
export type OAuthPollOutcome =
  | { status: "succeeded"; integrationId: string }
  | { status: "failed" }
  | { status: "timed_out" }
  | { status: "abandoned" };

export type OAuthPopup = Pick<Window, "closed" | "close"> & {
  location: Pick<Location, "assign">;
  opener: Window | null;
};

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type GetStatus = (
  attemptId: string,
  signal?: AbortSignal
) => Promise<OAuthAttemptStatus>;

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

function waitUnlessAborted<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) {
    return pending;
  }
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function attemptPath(attemptId: string): string {
  return `${getBasePath()}/api/integrations/oauth/attempts/${encodeURIComponent(attemptId)}`;
}

function responseError(
  status: number,
  body: ReturnType<typeof readJsonObject>,
  fallback: string
): ApiError {
  return new ApiError(
    status,
    typeof body?.error === "string" ? body.error : fallback
  );
}

/** Starts either OAuth mode without navigating away from the editor. */
export async function startOAuthConnection(
  input: OAuthStartInput,
  signal?: AbortSignal
): Promise<OAuthAuthorization> {
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
    throw responseError(
      response.status,
      body,
      "Failed to start OAuth authorization"
    );
  }
  if (
    typeof body?.attemptId !== "string" ||
    typeof body.authorizeUrl !== "string"
  ) {
    throw new ApiError(500, "OAuth start returned an invalid response");
  }
  return {
    attemptId: body.attemptId,
    authorizeUrl: body.authorizeUrl,
  };
}

/** Reads one attempt through the HttpOnly browser-binding cookie. */
export async function readOAuthAttemptStatus(
  attemptId: string,
  signal?: AbortSignal
): Promise<OAuthAttemptStatus> {
  const response = await fetch(attemptPath(attemptId), {
    credentials: "same-origin",
    signal,
  });
  const body = readJsonObject(await response.json().catch(() => null));
  if (!response.ok) {
    throw responseError(
      response.status,
      body,
      "Failed to check OAuth authorization"
    );
  }
  if (body?.status === "pending" || body?.status === "failed") {
    return { status: body.status };
  }
  if (body?.status === "succeeded" && typeof body.integrationId === "string") {
    return { status: "succeeded", integrationId: body.integrationId };
  }
  throw new ApiError(500, "OAuth status returned an invalid response");
}

/** Reserve before any request so the browser still recognizes the click. */
export function reserveOAuthPopup(): OAuthPopup | null {
  const popup = window.open("", "_blank", "popup");
  if (popup) {
    popup.opener = null;
  }
  return popup;
}

/** Polls durable attempt state until it becomes terminal or times out. */
export async function pollOAuthAttempt({
  attemptId,
  popup,
  intervalMs = OAUTH_POLL_INTERVAL_MS,
  timeoutMs = OAUTH_POLL_TIMEOUT_MS,
  getStatus = readOAuthAttemptStatus,
  sleep: wait = sleep,
  now = Date.now,
  signal,
}: {
  attemptId: string;
  popup: Pick<OAuthPopup, "closed">;
  intervalMs?: number;
  timeoutMs?: number;
  getStatus?: GetStatus;
  sleep?: Sleep;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<OAuthPollOutcome> {
  const startedAt = now();
  let closedPopupPolls = 0;

  while (true) {
    throwIfAborted(signal);
    if (now() - startedAt >= timeoutMs) {
      return { status: "timed_out" };
    }

    // eslint-disable-next-line no-await-in-loop -- each status determines whether another request is needed.
    const status = await waitUnlessAborted(
      getStatus(attemptId, signal),
      signal
    );
    throwIfAborted(signal);
    if (status.status !== "pending") {
      return status;
    }

    if (popup.closed) {
      closedPopupPolls += 1;
      if (closedPopupPolls >= CLOSED_POPUP_FINAL_POLLS) {
        return { status: "abandoned" };
      }
    } else {
      closedPopupPolls = 0;
    }

    // eslint-disable-next-line no-await-in-loop -- OAuth polls are intentionally sequential and separated by an abortable delay.
    await waitUnlessAborted(wait(intervalMs, signal), signal);
  }
}
