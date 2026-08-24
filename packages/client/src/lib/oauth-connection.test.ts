import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginCreatedOAuthConnection,
  beginExistingOAuthConnection,
  integrationOAuthStartUrl,
  pollOAuthConnection,
} from "./oauth-connection";

function setBaseHref(href: string | null): void {
  document.head.innerHTML = href === null ? "" : `<base href="${href}" />`;
}

function popup(): {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  location: { assign: ReturnType<typeof vi.fn> };
} {
  return {
    closed: false,
    close: vi.fn(),
    location: { assign: vi.fn() },
  };
}

afterEach(() => {
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OAuth connection helpers", () => {
  it("does not start authorization when the browser blocks the creation popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const start = vi.fn();

    const result = await beginCreatedOAuthConnection({ start });

    expect(result).toEqual({ status: "popup_blocked" });
    expect(start).not.toHaveBeenCalled();
  });

  it("starts a deferred connection before navigating its reserved popup", async () => {
    const reservedPopup = popup();
    const order: string[] = [];
    vi.spyOn(window, "open").mockImplementation(() => {
      order.push("open");
      return reservedPopup as unknown as Window;
    });
    const start = vi.fn(async () => {
      order.push("start");
      return {
        integrationId: "connection_1",
        authorizeUrl: "https://provider.example/authorize",
      };
    });
    reservedPopup.location.assign.mockImplementation(() =>
      order.push("navigate")
    );

    await beginCreatedOAuthConnection({ start });

    expect(order).toEqual(["open", "start", "navigate"]);
    expect(reservedPopup.location.assign).toHaveBeenCalledWith(
      "https://provider.example/authorize"
    );
  });

  it("stops polling when the pending authorization connects", async () => {
    const reservedPopup = popup();
    const fetchQuery = vi
      .fn()
      .mockResolvedValueOnce([{ id: "connection_1", oauth: undefined }])
      .mockResolvedValueOnce([
        {
          id: "connection_1",
          oauth: {
            status: "connected",
            connectedAt: "2026-08-24T10:00:00.000Z",
          },
        },
      ]);
    const sleep = vi.fn(async () => {
      reservedPopup.closed = true;
    });

    const result = await pollOAuthConnection({
      integrationId: "connection_1",
      popup: reservedPopup,
      queryClient: { fetchQuery },
      sleep,
    });

    expect(result.status).toBe("connected");
    expect(fetchQuery).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("waits for the popup to close before accepting a changed authorization", async () => {
    const reservedPopup = popup();
    const fetchQuery = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "connection_1",
          oauth: {
            status: "connected",
            connectedAt: "2026-08-24T10:00:00.000Z",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "connection_1",
          oauth: {
            status: "connected",
            connectedAt: "2026-08-24T10:00:00.000Z",
          },
        },
      ]);
    const sleep = vi.fn(async () => {
      reservedPopup.closed = true;
    });

    const result = await pollOAuthConnection({
      integrationId: "connection_1",
      popup: reservedPopup,
      queryClient: { fetchQuery },
      sleep,
    });

    expect(result.status).toBe("connected");
    expect(fetchQuery).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("waits for a reconnect to change the existing authorization result", async () => {
    const reservedPopup = popup();
    const fetchQuery = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "connection_1",
          oauth: {
            status: "reauthorization_required",
            connectedAt: "2026-08-24T10:00:00.000Z",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "connection_1",
          oauth: {
            status: "connected",
            connectedAt: "2026-08-24T11:00:00.000Z",
          },
        },
      ]);
    const sleep = vi.fn(async () => {
      reservedPopup.closed = true;
    });

    const result = await pollOAuthConnection({
      baseline: {
        status: "reauthorization_required",
        connectedAt: "2026-08-24T10:00:00.000Z",
      },
      integrationId: "connection_1",
      popup: reservedPopup,
      queryClient: { fetchQuery },
      sleep,
    });

    expect(result.status).toBe("connected");
    expect(fetchQuery).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("checks a closed popup several final times before leaving authorization pending", async () => {
    const fetchQuery = vi.fn().mockResolvedValue([]);
    const sleep = vi.fn(async () => undefined);
    const closedPopup = popup();
    closedPopup.closed = true;

    const result = await pollOAuthConnection({
      integrationId: "connection_1",
      popup: closedPopup,
      queryClient: { fetchQuery },
      sleep,
    });

    expect(result).toEqual({ status: "pending" });
    expect(fetchQuery).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns an unchanged reauthorization result after the popup closes", async () => {
    const unchanged = {
      id: "connection_1",
      oauth: {
        status: "reauthorization_required" as const,
        connectedAt: "2026-08-24T10:00:00.000Z",
      },
    };
    const fetchQuery = vi.fn().mockResolvedValue([unchanged]);
    const sleep = vi.fn(async () => undefined);
    const closedPopup = popup();
    closedPopup.closed = true;

    const result = await pollOAuthConnection({
      baseline: unchanged.oauth,
      integrationId: unchanged.id,
      popup: closedPopup,
      queryClient: { fetchQuery },
      sleep,
    });

    expect(result).toEqual({
      status: "reauthorization_required",
      integration: unchanged,
    });
    expect(fetchQuery).toHaveBeenCalledTimes(3);
  });

  it("stops polling immediately when its owner cancels the authorization", async () => {
    const controller = new AbortController();
    const fetchQuery = vi.fn().mockResolvedValue([]);
    const sleep = vi.fn(() => new Promise<void>(() => undefined));

    const polling = pollOAuthConnection({
      integrationId: "connection_1",
      popup: popup(),
      queryClient: { fetchQuery },
      signal: controller.signal,
      sleep,
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());

    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchQuery).toHaveBeenCalledOnce();
  });

  it("opens an existing connection's authorization route for reconnecting", () => {
    const reservedPopup = popup();
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );

    const result = beginExistingOAuthConnection("connection_1");

    expect(result.status).toBe("started");
    expect(reservedPopup.location.assign).toHaveBeenCalledWith(
      "/api/integrations/connection_1/oauth/start"
    );
  });

  it("adds the application's base path to OAuth routes", () => {
    setBaseHref("/wfgraph/");

    expect(integrationOAuthStartUrl("connection_1")).toBe(
      "/wfgraph/api/integrations/connection_1/oauth/start"
    );
  });
});
