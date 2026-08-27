import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ConfigureConnectionOverlay } from "#src/components/overlays/add-connection-overlay";
import { EditConnectionOverlay } from "#src/components/overlays/edit-connection-overlay";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import type { Integration } from "#src/lib/rpc-client";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const catalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [
    {
      type: "resend",
      label: "Resend",
      description: "Email delivery",
      credentialFields: {
        RESEND_API_KEY: { label: "API key", type: "password" },
        RESEND_ACCOUNT_SECRET: { label: "Account secret", type: "password" },
        RESEND_FROM_EMAIL: { label: "From email", type: "text" },
      },
      hasTest: true,
      oauth: { label: "Resend" },
    },
  ],
};

type OAuthConnection = NonNullable<Integration["oauth"]>;

function connection(
  oauth?: Omit<OAuthConnection, "credentialKeys"> & {
    credentialKeys?: readonly string[];
  },
  configuredKeys: readonly string[] = ["RESEND_ACCOUNT_SECRET"]
): Integration {
  return {
    id: "connection_1",
    name: "Production",
    type: "resend",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
    configuredKeys,
    oauth: oauth && { credentialKeys: [], ...oauth },
  };
}

function renderOverlay(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <ExtensionCatalogProvider value={catalog}>
      <QueryClientProvider client={queryClient}>
        <OverlayProvider>{children}</OverlayProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A popup that reports itself closed as soon as the flow navigates it. */
function stubOAuthPopup() {
  const popup = {
    closed: false,
    opener: null,
    close: vi.fn(),
    location: { assign: vi.fn() },
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  popup.location.assign.mockImplementation(() => {
    popup.closed = true;
  });
  return popup;
}

function stubOAuthStart() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).endsWith("/api/integrations/oauth/start")
      ? new Response(
          JSON.stringify({
            attemptId: "attempt_1",
            authorizeUrl: "https://provider.example/authorize",
          }),
          { headers: { "content-type": "application/json" } }
        )
      : new Response(JSON.stringify({ status: "pending" }), {
          headers: { "content-type": "application/json" },
        })
  );
}

function startRequestBody(
  fetch: ReturnType<typeof stubOAuthStart>
): Record<string, unknown> {
  const call = fetch.mock.calls.find(([input]) =>
    String(input).endsWith("/api/integrations/oauth/start")
  );
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

describe("OAuth granted access", () => {
  it("names what the provider granted on a connected connection", () => {
    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
          grantedAccessLabel: "Full access",
        })}
        overlayId="edit_resend"
      />
    );

    expect(screen.getByText("Access: Full access")).toBeTruthy();
  });

  it("says nothing about access for a grant that never reported it", () => {
    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
        })}
        overlayId="edit_resend"
      />
    );

    expect(screen.queryByText(/^Access:/u)).toBeNull();
  });

  it("offers Reconnect on a working connection, which is the only way to change access", async () => {
    stubOAuthPopup();
    const fetch = stubOAuthStart();

    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
          grantedAccessLabel: "Sending access",
        })}
        overlayId="edit_resend"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(startRequestBody(fetch)).toEqual({
      mode: "reconnect",
      integrationId: "connection_1",
    });
  });
});

describe("OAuth connection overlays", () => {
  it("sends every entered password setting when creating an OAuth connection", async () => {
    const reservedPopup = {
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { assign: vi.fn() },
    };
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );
    reservedPopup.location.assign.mockImplementation(() => {
      reservedPopup.closed = true;
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input) => {
        if (String(_input).endsWith("/api/integrations/oauth/start")) {
          return new Response(
            JSON.stringify({
              attemptId: "attempt_1",
              authorizeUrl: "https://provider.example/authorize",
            }),
            { headers: { "content-type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            status: "succeeded",
            integrationId: "connection_1",
          }),
          { headers: { "content-type": "application/json" } }
        );
      });

    renderOverlay(
      <ConfigureConnectionOverlay overlayId="add_resend" type="resend" />
    );
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "api-key" },
    });
    fireEvent.change(screen.getByLabelText("Account secret"), {
      target: { value: "account-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Connect with Resend" })
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const startRequest = fetch.mock.calls.find(([input]) =>
      String(input).endsWith("/api/integrations/oauth/start")
    );
    expect(startRequest).toBeDefined();
    expect(JSON.parse(String(startRequest?.[1]?.body))).toMatchObject({
      mode: "create",
      config: {
        RESEND_ACCOUNT_SECRET: "account-secret",
        RESEND_API_KEY: "api-key",
      },
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Connect with Resend",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(
      fetch.mock.calls.some(
        ([input]) =>
          String(input).endsWith("/api/rpc/integration/create") ||
          String(input).endsWith("/api/rpc/integration/delete")
      )
    ).toBe(false);
  });

  it("cancels OAuth and closes its popup when the dialog closes", async () => {
    const reservedPopup = {
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { assign: vi.fn() },
    };
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input) => {
      if (String(_input).endsWith("/api/integrations/oauth/start")) {
        return new Response(
          JSON.stringify({
            attemptId: "attempt_1",
            authorizeUrl: "https://provider.example/authorize",
          }),
          { headers: { "content-type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ status: "pending" }), {
        headers: { "content-type": "application/json" },
      });
    });

    const rendered = renderOverlay(
      <ConfigureConnectionOverlay overlayId="add_resend" type="resend" />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Connect with Resend" })
    );
    await waitFor(() =>
      expect(reservedPopup.location.assign).toHaveBeenCalledOnce()
    );

    rendered.unmount();

    expect(reservedPopup.close).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(([input]) =>
          String(input).endsWith("/api/rpc/integration/delete")
        )
    ).toBe(false);
  });

  it("keeps the manual path and its fields alongside the OAuth path", () => {
    renderOverlay(
      <ConfigureConnectionOverlay overlayId="add_resend" type="resend" />
    );

    expect(
      screen.getByRole("heading", { name: "Connect with Resend" })
    ).toBeTruthy();
    expect(screen.getByText("Manual configuration")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByLabelText("From email")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create manually" })
    ).toBeTruthy();
  });

  it("renders connected OAuth state with text, account, date, and disconnect control", () => {
    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
          accountLabel: "alerts@example.com",
        })}
        overlayId="edit_resend"
      />
    );

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Account: alerts@example.com")).toBeTruthy();
    expect(screen.getByText("Connected on 2026-08-24")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("keeps OAuth-managed credentials read-only while leaving other settings editable", () => {
    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
          credentialKeys: ["RESEND_API_KEY", "RESEND_ACCOUNT_SECRET"],
        })}
        overlayId="edit_resend"
      />
    );

    expect(screen.getAllByText("Managed by Resend OAuth")).toHaveLength(2);
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByLabelText("Account secret")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.getByLabelText("From email")).toBeTruthy();
  });

  it("tests edited settings through the saved connection with proposed config", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ status: "success", message: "Connected" }),
          { headers: { "content-type": "application/json" } }
        )
      );

    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
          credentialKeys: ["RESEND_API_KEY"],
        })}
        overlayId="edit_resend"
      />
    );
    fireEvent.change(screen.getByLabelText("From email"), {
      target: { value: "alerts@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]?.[0]).toEqual(
      expect.stringMatching(/\/api\/rpc\/integration\/testConnection$/)
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      json: {
        integrationId: "connection_1",
        config: { RESEND_FROM_EMAIL: "alerts@example.com" },
      },
    });
  });

  it("runs the pre-save test through the saved connection with proposed config", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ status: "error", message: "Unavailable" }),
        {
          headers: { "content-type": "application/json" },
        }
      )
    );

    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
          credentialKeys: ["RESEND_API_KEY"],
        })}
        overlayId="edit_resend"
      />
    );
    fireEvent.change(screen.getByLabelText("From email"), {
      target: { value: "alerts@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]?.[0]).toEqual(
      expect.stringMatching(/\/api\/rpc\/integration\/testConnection$/)
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      json: {
        integrationId: "connection_1",
        config: { RESEND_FROM_EMAIL: "alerts@example.com" },
      },
    });
  });

  it("disconnects OAuth through the typed integration mutation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ json: { success: true } }), {
        headers: { "content-type": "application/json" },
      })
    );

    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "connected",
          connectedAt: "2026-08-24T10:00:00.000Z",
          credentialKeys: ["RESEND_API_KEY"],
        })}
        overlayId="edit_resend"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/rpc\/integration\/disconnectOAuth$/),
        expect.objectContaining({ method: "POST" })
      )
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      json: { integrationId: "connection_1" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Managed by Resend OAuth")).toBeNull()
    );
    // The grant held the only API key, so the field is an empty input rather
    // than the "Configured" state a stored value earns.
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      ""
    );
    // Disconnecting is reversible: this is the only offer of the OAuth flow a
    // saved connection has, so losing it would strand the connection.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  // The server keeps a manual value the grant was shadowing, so the field it
  // belongs to reports itself configured once OAuth is gone.
  it("keeps a manual secret configured after a disconnect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ json: { success: true } }), {
        headers: { "content-type": "application/json" },
      })
    );

    renderOverlay(
      <EditConnectionOverlay
        integration={connection(
          {
            status: "connected",
            connectedAt: "2026-08-24T10:00:00.000Z",
            credentialKeys: ["RESEND_API_KEY"],
          },
          ["RESEND_API_KEY", "RESEND_ACCOUNT_SECRET"]
        )}
        overlayId="edit_resend"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Change" })).toHaveLength(2)
    );
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("offers the OAuth flow on a connection that has never used it", () => {
    renderOverlay(
      <EditConnectionOverlay
        integration={connection(undefined, [])}
        overlayId="edit_resend"
      />
    );

    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      ""
    );
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("renders reauthorization as a textual state with reconnect control", () => {
    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "reauthorization_required",
          connectedAt: "2026-08-24T10:00:00.000Z",
          credentialKeys: ["RESEND_API_KEY"],
        })}
        overlayId="edit_resend"
      />
    );

    expect(screen.getByText("Reauthorization required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.getByText("Managed by Resend OAuth")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("starts reconnect through the unified attempt endpoint", async () => {
    const reservedPopup = {
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { assign: vi.fn() },
    };
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attemptId: "attempt_1",
            authorizeUrl: "https://provider.example/authorize",
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "failed" }), {
          headers: { "content-type": "application/json" },
        })
      );

    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "reauthorization_required",
          connectedAt: "2026-08-24T10:00:00.000Z",
        })}
        overlayId="edit_resend"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      mode: "reconnect",
      integrationId: "connection_1",
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
  });
});
