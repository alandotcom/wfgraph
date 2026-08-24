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

function connection(oauth?: Integration["oauth"]): Integration {
  return {
    id: "connection_1",
    name: "Production",
    type: "resend",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
    oauth,
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
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              json: {
                id: "connection_1",
                name: "",
                type: "resend",
                createdAt: "2026-08-24T10:00:00.000Z",
                updatedAt: "2026-08-24T10:00:00.000Z",
              },
            }),
            { headers: { "content-type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            json: [
              {
                id: "connection_1",
                name: "",
                type: "resend",
                createdAt: "2026-08-24T10:00:00.000Z",
                updatedAt: "2026-08-24T10:00:00.000Z",
                oauth: {
                  status: "connected",
                  connectedAt: "2026-08-24T11:00:00.000Z",
                },
              },
            ],
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
    const createRequest = fetch.mock.calls.find(
      ([, init]) => init?.method === "POST"
    );
    expect(createRequest).toBeDefined();
    expect(JSON.parse(String(createRequest?.[1]?.body))).toMatchObject({
      json: {
        config: {
          RESEND_ACCOUNT_SECRET: "account-secret",
          RESEND_API_KEY: "api-key",
        },
      },
    });
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

  it("renders reauthorization as a textual state with reconnect control", () => {
    renderOverlay(
      <EditConnectionOverlay
        integration={connection({
          status: "reauthorization_required",
          connectedAt: "2026-08-24T10:00:00.000Z",
        })}
        overlayId="edit_resend"
      />
    );

    expect(screen.getByText("Reauthorization required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});
