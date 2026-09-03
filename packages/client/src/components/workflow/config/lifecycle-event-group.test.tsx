import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { LifecyclePanel } from "#src/components/workflow/config/lifecycle-panel";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";

const resendCatalog: ExtensionCatalog = {
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [{ path: "appointment.id", type: "string" }],
    },
    {
      name: "resend/email.sent",
      label: "Email sent",
      integration: "resend",
      correlationPath: "data.email_id",
      payloadFields: [{ path: "data.email_id", type: "string" }],
    },
    {
      name: "resend/email.delivered",
      label: "Email delivered",
      integration: "resend",
      correlationPath: "data.email_id",
      payloadFields: [{ path: "data.email_id", type: "string" }],
    },
    {
      name: "resend/email.bounced",
      label: "Email bounced",
      integration: "resend",
      correlationPath: "data.email_id",
      payloadFields: [{ path: "data.email_id", type: "string" }],
    },
  ],
  actions: [],
  integrations: [
    {
      type: "resend",
      label: "Resend",
      description: "Send transactional emails",
      credentialFields: {},
      hasTest: true,
      hasWebhook: true,
      webhookHelpText: "Paste this URL into Resend.",
      webhookSecretKey: "RESEND_WEBHOOK_SECRET",
    },
  ],
};

const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created", "resend/email.delivered"],
  cancelEvents: [],
  concurrency: "unlimited",
  connectionIds: { "resend/email.delivered": "conn_1" },
};

const resendConnection: Integration = {
  id: "conn_1",
  name: "Resend API Key",
  type: "resend",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  configuredKeys: [],
  connectionDefaults: {},
};

function renderPanel(input: {
  rules?: LifecycleRules;
  connections?: Integration[];
  disabled?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(
    integrationsQueryOptions().queryKey,
    input.connections ?? []
  );

  const view = render(
    <ExtensionCatalogProvider value={resendCatalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={createStore()}>
          <OverlayProvider>
            <LifecyclePanel
              config={{ lifecycleRules: input.rules ?? startRules }}
              disabled={input.disabled ?? false}
              onUpdateConfig={() => undefined}
            />
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );

  return view;
}

describe("LifecyclePanel Connection picker", () => {
  it("gives both Event groups clear headings", () => {
    const view = renderPanel({});

    for (const name of ["Start Events", "Cancel Events"]) {
      const heading = view.getByRole("heading", { level: 4, name });

      expect(heading.className).toContain("text-sm");
      expect(heading.className).toContain("text-foreground");
      expect(heading.className).not.toContain("text-muted-foreground");
    }
  });

  it("presents each selected Event as the heading of its configuration", () => {
    const view = renderPanel({});

    const eventHeading = view.getByRole("heading", {
      level: 5,
      name: "Appointment created",
    });

    expect(eventHeading.className).toContain("text-base");
    expect(eventHeading.className).toContain("font-semibold");
  });

  it("offers a Connection only for an integration-owned Event", () => {
    const view = renderPanel({});

    expect(view.getByText("Appointment created")).toBeTruthy();
    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(
      view.getByRole("combobox", { name: "Resend connection" })
    ).toBeTruthy();
    expect(
      view.queryByRole("combobox", {
        name: "Appointment created connection",
      })
    ).toBeNull();
  });

  it("offers one Connection for every Event of the same integration", () => {
    const view = renderPanel({
      rules: {
        startEvents: ["resend/email.sent", "resend/email.delivered"],
        cancelEvents: [],
        concurrency: "unlimited",
      },
    });

    expect(view.getByText("Email sent")).toBeTruthy();
    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(
      view.getAllByRole("combobox", { name: "Resend connection" })
    ).toHaveLength(1);
  });

  it("offers one Connection when Start and Cancel name the same integration", () => {
    const view = renderPanel({
      rules: {
        startEvents: ["resend/email.sent"],
        cancelEvents: ["resend/email.bounced"],
        concurrency: "unlimited",
      },
    });

    expect(view.getByText("Email sent")).toBeTruthy();
    expect(view.getByText("Email bounced")).toBeTruthy();
    expect(
      view.getAllByRole("combobox", { name: "Resend connection" })
    ).toHaveLength(1);
  });

  it("shows the webhook URL next to that Connection", () => {
    const view = renderPanel({
      connections: [resendConnection],
    });

    expect(view.getByText("Webhook URL")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Add signing secret" })
    ).toBeTruthy();
  });

  it("does not ask for a signing secret the Connection already holds", () => {
    const view = renderPanel({
      connections: [
        {
          ...resendConnection,
          configuredKeys: ["RESEND_WEBHOOK_SECRET"],
        },
      ],
    });

    expect(view.getByRole("button", { name: "Edit connection" })).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Add signing secret" })
    ).toBeNull();
  });

  it("disables Add signing secret when the editor is disabled", () => {
    const view = renderPanel({
      connections: [resendConnection],
      disabled: true,
    });

    expect(
      view.getByRole("button", { name: "Add signing secret" })
    ).toHaveProperty("disabled", true);
  });

  it("disables Edit connection when the editor is disabled", () => {
    const view = renderPanel({
      connections: [
        {
          ...resendConnection,
          configuredKeys: ["RESEND_WEBHOOK_SECRET"],
        },
      ],
      disabled: true,
    });

    expect(
      view.getByRole("button", { name: "Edit connection" })
    ).toHaveProperty("disabled", true);
  });

  it("shows the stored Connection", () => {
    const view = renderPanel({
      connections: [resendConnection],
    });

    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(view.getByText("Resend API Key")).toBeTruthy();
    expect(view.getByText("Webhook URL")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Add signing secret" })
    ).toBeTruthy();
    expect(view.queryByText("conn_1")).toBeNull();
  });
});
