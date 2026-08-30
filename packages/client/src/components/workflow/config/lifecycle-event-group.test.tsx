import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
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
    },
  ],
};

const startRules: LifecycleRules = {
  startEvents: ["app/appointment.created", "resend/email.delivered"],
  cancelEvents: [],
  concurrency: "unlimited",
  connectionIds: { "resend/email.delivered": "conn_1" },
};

function renderGroup(input: { editing: boolean; rules?: LifecycleRules }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(integrationsQueryOptions().queryKey, []);

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

  it("shows the stored Connection in view mode", () => {
    const view = renderGroup({ editing: false });

    expect(view.getByText("Email delivered")).toBeTruthy();
    expect(view.getByText("conn_1")).toBeTruthy();
  });
});
