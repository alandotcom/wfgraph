import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import type { Integration } from "#src/lib/rpc-client";
import { integrationsQueryOptions } from "#src/lib/rpc-query";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { LifecycleEventGroup } from "./lifecycle-event-group";

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
      webhookHelpText:
        "Create a webhook in Resend with all event types selected.",
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
};

function renderGroup(input: {
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

  return render(
    <ExtensionCatalogProvider value={resendCatalog}>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={createStore()}>
          <OverlayProvider>
            <LifecycleEventGroup
              catalog={resendCatalog}
              disabled={false}
              editing={input.editing}
              inputId="start-events"
              onConnectionChange={() => undefined}
              onCorrelationPathChange={() => undefined}
              onEventNamesChange={() => undefined}
              role="start"
              rules={input.rules ?? startRules}
            />
          </OverlayProvider>
        </JotaiProvider>
      </QueryClientProvider>
    </ExtensionCatalogProvider>
  );
}

describe("LifecycleEventGroup Connection picker", () => {
  it("offers a Connection only for an integration-owned Event", () => {
    const view = renderGroup({ editing: true });

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
    const view = renderGroup({
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

  it("shows the webhook URL next to that Connection", () => {
    const view = renderGroup({
      editing: true,
      connections: [resendConnection],
    });

    expect(view.getByText("Webhook URL")).toBeTruthy();
  });

  it("shows the stored Connection in view mode", () => {
    const view = renderGroup({
      editing: false,
      connections: [resendConnection],
    });

    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(view.getByText("Resend API Key")).toBeTruthy();
    expect(view.getByText("Webhook URL")).toBeTruthy();
    expect(view.queryByText("conn_1")).toBeNull();
  });
});
