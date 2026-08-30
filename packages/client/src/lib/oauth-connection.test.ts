import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollOAuthAttempt,
  readOAuthAttemptStatus,
  reserveOAuthPopup,
  startOAuthConnection,
} from "./oauth-connection";

function setBaseHref(href: string | null): void {
  document.head.innerHTML = href === null ? "" : `<base href="${href}" />`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OAuth connection helpers", () => {
  it("reserves the provider popup synchronously and severs its opener", () => {
    const reservedPopup = {
      closed: false,
      opener: window,
      close: vi.fn(),
      location: { assign: vi.fn() },
    };
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );

    const result = reserveOAuthPopup();

    expect(result).toBe(reservedPopup);
    expect(reservedPopup.opener).toBeNull();
  });

  it("sends create attempts through the unified start endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        attemptId: "attempt_1",
        authorizeUrl: "https://provider.example/authorize",
      })
    );

    const result = await startOAuthConnection({
      mode: "create",
      name: "Production",
      type: "resend",
      config: { RESEND_API_KEY: "secret" },
    });

    expect(result).toEqual({
      attemptId: "attempt_1",
      authorizeUrl: "https://provider.example/authorize",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/integrations/oauth/start",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          mode: "create",
          name: "Production",
          type: "resend",
          config: { RESEND_API_KEY: "secret" },
        }),
      })
    );
  });

  it("sends reconnect attempts through the unified start endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        attemptId: "attempt_2",
        authorizeUrl: "https://provider.example/authorize",
      })
    );

    await startOAuthConnection({
      mode: "reconnect",
      integrationId: "connection_1",
    });

    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({
      mode: "reconnect",
      integrationId: "connection_1",
    });
  });

  it("reads browser-bound attempt status below the application base path", async () => {
    setBaseHref("/wfgraph/");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ status: "succeeded", integrationId: "connection_1" })
      );

    const result = await readOAuthAttemptStatus("attempt/1");

    expect(result).toEqual({
      status: "succeeded",
      integrationId: "connection_1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/wfgraph/api/integrations/oauth/attempts/attempt%2F1",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });

  it("polls the attempt until the server records a terminal result", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({
        status: "succeeded",
        integrationId: "connection_1",
      });
    const sleep = vi.fn(async () => undefined);

    const result = await pollOAuthAttempt({
      attemptId: "attempt_1",
      getStatus,
      sleep,
    });

    expect(result).toEqual({
      status: "succeeded",
      integrationId: "connection_1",
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("keeps polling after the popup reports closed until the server records success", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({
        status: "succeeded",
        integrationId: "connection_1",
      });
    const sleep = vi.fn(async () => undefined);

    const result = await pollOAuthAttempt({
      attemptId: "attempt_1",
      getStatus,
      sleep,
    });

    expect(result).toEqual({
      status: "succeeded",
      integrationId: "connection_1",
    });
    expect(getStatus).toHaveBeenCalledTimes(4);
  });

  it("answers timed out when nobody finishes the authorization in time", async () => {
    const getStatus = vi.fn().mockResolvedValue({ status: "pending" });
    const sleep = vi.fn(async () => undefined);
    let elapsed = 0;

    const result = await pollOAuthAttempt({
      attemptId: "attempt_1",
      getStatus,
      sleep,
      timeoutMs: 100,
      now: () => {
        const reading = elapsed;
        elapsed += 50;
        return reading;
      },
    });

    expect(result).toEqual({ status: "timed_out" });
  });

  it("aborts while waiting between status requests", async () => {
    const controller = new AbortController();
    const getStatus = vi.fn().mockResolvedValue({ status: "pending" });
    const sleep = vi.fn(() => new Promise<void>(() => undefined));

    const polling = pollOAuthAttempt({
      attemptId: "attempt_1",
      getStatus,
      signal: controller.signal,
      sleep,
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());

    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("passes cancellation to an in-flight status request", async () => {
    const controller = new AbortController();
    const getStatus = vi.fn(
      (_attemptId: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Canceled", "AbortError")),
            { once: true }
          );
        })
    );

    const polling = pollOAuthAttempt({
      attemptId: "attempt_1",
      getStatus,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledOnce());

    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(getStatus).toHaveBeenCalledWith("attempt_1", controller.signal);
  });
});
