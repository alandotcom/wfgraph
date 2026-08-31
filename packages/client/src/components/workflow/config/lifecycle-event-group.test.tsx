import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
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
  editing: boolean;
  rules?: LifecycleRules;
  connections?: Integration[];
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
              disabled={false}
              onUpdateConfig={() => undefined}
            />
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );

  if (input.editing) {
    fireEvent.click(view.getByRole("button", { name: "Edit Lifecycle Rules" }));
  }

  return view;
}

describe("LifecyclePanel Connection picker", () => {
  it("offers a Connection only for an integration-owned Event", () => {
    const view = renderPanel({ editing: true });

    expect(view.getByText("Appointment created")).toBeTruthy();
    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Add Resend connection" })
    ).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Add Appointment created connection" })
    ).toBeNull();
  });

  it("offers one Connection for every Event of the same integration", () => {
    const view = renderPanel({
      editing: true,
      rules: {
        startEvents: ["resend/email.sent", "resend/email.delivered"],
        cancelEvents: [],
        concurrency: "unlimited",
      },
    });

    expect(view.getByText("Email sent")).toBeTruthy();
    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(
      view.getAllByRole("button", { name: "Add Resend connection" })
    ).toHaveLength(1);
  });

  it("offers one Connection when Start and Cancel name the same integration", () => {
    const view = renderPanel({
      editing: true,
      rules: {
        startEvents: ["resend/email.sent"],
        cancelEvents: ["resend/email.bounced"],
        concurrency: "unlimited",
      },
    });

    expect(view.getByText("Email sent")).toBeTruthy();
    expect(view.getByText("Email bounced")).toBeTruthy();
    expect(
      view.getAllByRole("button", { name: "Add Resend connection" })
    ).toHaveLength(1);
  });

  it("shows the webhook URL next to that Connection", () => {
    const view = renderPanel({
      editing: true,
      connections: [resendConnection],
    });

    expect(view.getByText("Webhook URL")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Add signing secret" })
    ).toBeTruthy();
  });

  it("does not ask for a signing secret the Connection already holds", () => {
    const view = renderPanel({
      editing: false,
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

  it("shows the stored Connection in view mode", () => {
    const view = renderPanel({
      editing: false,
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
