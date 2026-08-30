import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ConfigureConnectionOverlay } from "#src/components/overlays/add-connection-overlay";
import { EditConnectionOverlay } from "#src/components/overlays/edit-connection-overlay";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
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
      hasWebhook: false,
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

function integrationListResponse(
  integrations: readonly Integration[]
): Response {
  return new Response(JSON.stringify({ json: integrations }), {
    headers: { "content-type": "application/json" },
  });
}

/**
 * Disconnect asks before it acts, so both clicks are the interaction.
 *
 * It revokes the grant at the provider, which the app cannot undo, and when the
 * grant was the only credential it removes the connection with it. The confirm
 * button is named for which of those is about to happen.
 */
async function confirmDisconnect(confirmLabel: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  const confirm = await screen.findByRole("button", { name: confirmLabel });
  // The confirm click starts the disconnect mutation, and the answer pops this
  // overlay off the stack. Settling that here keeps the update inside act, and
  // the caller's `waitFor` then runs against a stack that has changed.
  await act(async () => {
    fireEvent.click(confirm);
  });
}

type RenderOverlayOptions = {
  integration?: Integration;
  queryClient?: QueryClient;
};

function renderOverlay(
  children: React.ReactNode,
  options: RenderOverlayOptions = {}
) {
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });

  if (options.integration) {
    queryClient.setQueryData(integrationsQueryOptions().queryKey, [
      options.integration,
    ]);
  }

  return render(
    <ExtensionCatalogProvider value={catalog}>
      <QueryClientProvider client={queryClient}>
        <OverlayProvider>
          {children}
          {/*
            These cases render the overlay under test directly rather than
            pushing it, but it pushes overlays of its own -- the disconnect
            confirmation, the delete confirmation -- and only the container
            renders a pushed stack. Without it those steps are invisible here.
          */}
          <OverlayContainer />
        </OverlayProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
}

function renderEditOverlay(
  integration: Integration,
  options: {
    onDelete?: () => void;
    onSuccess?: () => void;
    queryClient?: QueryClient;
  } = {}
) {
  const { queryClient, ...overlayProps } = options;
  return renderOverlay(
    <EditConnectionOverlay
      integration={integration}
      overlayId="edit_resend"
      {...overlayProps}
    />,
    { integration, queryClient }
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
    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      grantedAccessLabel: "Full access",
    });
    renderEditOverlay(integration);

    expect(screen.getByText("Access: Full access")).toBeTruthy();
  });

  it("says nothing about access for a grant that never reported it", () => {
    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
    });
    renderEditOverlay(integration);

    expect(screen.queryByText(/^Access:/u)).toBeNull();
  });

  it("offers Reconnect on a working connection, which is the only way to change access", async () => {
    stubOAuthPopup();
    const fetch = stubOAuthStart();

    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      grantedAccessLabel: "Sending access",
    });
    renderEditOverlay(integration);
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
    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      accountLabel: "alerts@example.com",
    });
    renderEditOverlay(integration);

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Account: alerts@example.com")).toBeTruthy();
    expect(screen.getByText("Connected on 2026-08-24")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("keeps OAuth-managed credentials read-only while leaving other settings editable", () => {
    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      credentialKeys: ["RESEND_API_KEY", "RESEND_ACCOUNT_SECRET"],
    });
    renderEditOverlay(integration);

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

    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      credentialKeys: ["RESEND_API_KEY"],
    });
    renderEditOverlay(integration);
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

    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      credentialKeys: ["RESEND_API_KEY"],
    });
    renderEditOverlay(integration);
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
    const disconnected = connection();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/api/rpc/integration/getAll")
          ? integrationListResponse([disconnected])
          : new Response(
              JSON.stringify({ json: { success: true, removed: false } }),
              { headers: { "content-type": "application/json" } }
            )
      );

    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      credentialKeys: ["RESEND_API_KEY"],
    });
    renderEditOverlay(integration);

    await confirmDisconnect("Disconnect Resend");

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/rpc\/integration\/disconnectOAuth$/),
        expect.objectContaining({ method: "POST" })
      )
    );
    const disconnectRequest = fetch.mock.calls.find(([input]) =>
      String(input).includes("/api/rpc/integration/disconnectOAuth")
    );
    expect(JSON.parse(String(disconnectRequest?.[1]?.body))).toEqual({
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
    const disconnected = connection(undefined, [
      "RESEND_API_KEY",
      "RESEND_ACCOUNT_SECRET",
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/api/rpc/integration/getAll")
        ? integrationListResponse([disconnected])
        : new Response(
            JSON.stringify({ json: { success: true, removed: false } }),
            { headers: { "content-type": "application/json" } }
          )
    );

    const integration = connection(
      {
        status: "connected",
        connectedAt: "2026-08-24T10:00:00.000Z",
        credentialKeys: ["RESEND_API_KEY"],
      },
      ["RESEND_API_KEY", "RESEND_ACCOUNT_SECRET"]
    );
    renderEditOverlay(integration);

    await confirmDisconnect("Disconnect Resend");

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Change" })).toHaveLength(2)
    );
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  // Disconnect revokes at the provider, which nothing here can undo, so the
  // click alone must not reach the server.
  it("asks before disconnecting, and sends nothing until it is confirmed", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ json: { success: true, removed: false } }),
          { headers: { "content-type": "application/json" } }
        )
      );

    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
      credentialKeys: ["RESEND_API_KEY"],
    });
    renderEditOverlay(integration);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(
      await screen.findByRole("button", { name: "Disconnect Resend" })
    ).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  // The two outcomes differ, and which one is about to happen is the server's
  // answer in `configuredKeys` rather than anything this dialog guesses.
  it("names removal when the grant is the connection's only credential", async () => {
    const integration = connection(
      {
        status: "connected",
        connectedAt: "2026-08-24T10:00:00.000Z",
        credentialKeys: ["RESEND_API_KEY"],
      },
      []
    );
    renderEditOverlay(integration);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(
      await screen.findByRole("button", { name: "Remove connection" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Disconnect Resend" })
    ).toBeNull();
  });

  // A grant that supplied the whole connection leaves nothing behind, so the
  // server removes the row and the editor has no connection left to edit.
  it("closes and repairs when disconnecting removed the connection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ json: { success: true, removed: true } }), {
        headers: { "content-type": "application/json" },
      })
    );
    const onDelete = vi.fn();

    const integration = connection(
      {
        status: "connected",
        connectedAt: "2026-08-24T10:00:00.000Z",
        credentialKeys: ["RESEND_API_KEY"],
      },
      []
    );
    renderEditOverlay(integration, { onDelete });

    await confirmDisconnect("Remove connection");

    // The nodes that named this connection are repaired through the same path a
    // delete takes. The dialog also closes, which this harness cannot see:
    // `closeAll` empties the overlay stack, and these cases render the overlay
    // directly rather than pushing it.
    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
  });

  it("offers the OAuth flow on a connection that has never used it", () => {
    renderEditOverlay(connection(undefined, []));

    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      ""
    );
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("renders reauthorization as a textual state with reconnect control", () => {
    renderEditOverlay(
      connection({
        status: "reauthorization_required",
        connectedAt: "2026-08-24T10:00:00.000Z",
        credentialKeys: ["RESEND_API_KEY"],
      })
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
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/oauth/start")) {
          return new Response(
            JSON.stringify({
              attemptId: "attempt_1",
              authorizeUrl: "https://provider.example/authorize",
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/api/integrations/oauth/attempts/attempt_1")) {
          return new Response(JSON.stringify({ status: "failed" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/rpc/integration/getAll")) {
          return integrationListResponse([
            connection({
              status: "reauthorization_required",
              connectedAt: "2026-08-24T10:00:00.000Z",
            }),
          ]);
        }
        throw new Error(`unexpected request: ${url}`);
      });

    renderEditOverlay(
      connection({
        status: "reauthorization_required",
        connectedAt: "2026-08-24T10:00:00.000Z",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    const startRequest = await waitFor(() => {
      const request = fetch.mock.calls.find(([input]) =>
        String(input).endsWith("/api/integrations/oauth/start")
      );
      expect(request).toBeDefined();
      return request;
    });
    expect(JSON.parse(String(startRequest?.[1]?.body))).toEqual({
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

  it("shows a failed reconnect's live reauthorization state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(integrationsQueryOptions().queryKey, [
      connection({
        status: "connected",
        connectedAt: "2026-08-24T10:00:00.000Z",
      }),
    ]);
    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      opener: null,
      close: vi.fn(),
      location: { assign: vi.fn() },
    } as unknown as Window);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/integrations/oauth/start")) {
          return new Response(
            JSON.stringify({
              attemptId: "attempt_1",
              authorizeUrl: "https://provider.example/authorize",
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/api/integrations/oauth/attempts/attempt_1")) {
          return new Response(JSON.stringify({ status: "failed" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/rpc/integration/getAll")) {
          return new Response(
            JSON.stringify({
              json: [
                connection({
                  status: "reauthorization_required",
                  connectedAt: "2026-08-24T10:00:00.000Z",
                }),
              ],
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`unexpected request: ${url}`);
      });

    const integration = connection({
      status: "connected",
      connectedAt: "2026-08-24T10:00:00.000Z",
    });
    renderEditOverlay(integration, { queryClient });
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() =>
      expect(screen.getByText("Reauthorization required")).toBeTruthy()
    );
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("/api/rpc/integration/getAll")
      )
    ).toBe(true);
  });
});
