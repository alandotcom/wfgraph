/**
 * Where a step's issues show in its form: beneath the field each one names
 * while that field is on screen, and otherwise in the list after the form, so
 * an issue never disappears with a field the form does not draw.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, within } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { NodePropertiesForm } from "#src/components/workflow/node-properties-form";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import {
  type WfGraphOperationId,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";

const catalog: ExtensionCatalog = {
  entities: [],
  events: [],
  integrations: [
    {
      type: "mailer",
      label: "Mailer",
      description: "Sends email",
      credentialFields: {},
      hasTest: false,
      hasWebhook: false,
    },
  ],
  actions: [
    {
      id: "mailer/send",
      label: "Send email",
      description: "Send one email",
      category: "Mailer",
      integration: "mailer",
      configFields: [
        {
          key: "format",
          label: "Format",
          type: "select",
          options: [
            { value: "text", label: "Text" },
            { value: "html", label: "HTML" },
          ],
        },
        {
          key: "html",
          label: "HTML body",
          type: "template-textarea",
          showWhen: { field: "format", equals: "html" },
        },
      ],
      outputFields: [],
    },
  ],
};

const STEP: WorkflowNode = {
  id: "send",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Send reminder",
    type: "action",
    config: { actionType: "mailer/send", format: "text" },
  },
};

const MISSING_CONNECTION: WorkflowIssue = {
  kind: "missing_integration",
  severity: "blocking",
  nodeId: "send",
  nodeLabel: "Send reminder",
  integrationType: "mailer",
  integrationLabel: "Mailer",
  message: "Send reminder needs a Mailer Connection.",
};

const HIDDEN_FIELD_ISSUE: WorkflowIssue = {
  kind: "broken_reference",
  severity: "blocking",
  nodeId: "send",
  nodeLabel: "Send reminder",
  fieldKey: "html",
  fieldLabel: "HTML body",
  referencedNodeId: "gone",
  displayText: "Gone.id",
  message: "HTML body reads a step that no longer exists.",
};

async function renderStepForm(input: {
  issues: readonly WorkflowIssue[];
  grants: readonly WfGraphOperationId[];
}) {
  installAuthorizationGrantsForTests(input.grants);
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes: [STEP], edges: [] });
  store.set(workflowIssuesAtom, [...input.issues]);
  const rootRoute = createRootRoute();
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    component: () => (
      <div data-testid="form">
        <NodePropertiesForm nodeId="send" />
      </div>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({ initialEntries: ["/workflows/wf_1"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["integration", "getAll"] as never, [] as never);
  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <IntegrationUiProvider value={{}}>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={store}>
            <OverlayProvider>
              <RouterProvider router={router} />
            </OverlayProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </IntegrationUiProvider>
    </ExtensionCatalogProvider>
  );
  return within(await view.findByTestId("form"));
}

afterEach(() => {
  resetAuthorizationGrantsForTests();
});

describe("a step's issues in its form", () => {
  it("shows a missing Connection beneath the picker to a person who can edit", async () => {
    const form = await renderStepForm({
      issues: [MISSING_CONNECTION],
      grants: [WfGraphOperations.workflowUpdate.id],
    });
    const messages = form.getAllByText(MISSING_CONNECTION.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.closest('[data-slot="field-issues"]')).not.toBeNull();
  });

  it("shows a missing Connection to a read-only viewer, who gets no picker", async () => {
    const form = await renderStepForm({
      issues: [MISSING_CONNECTION],
      grants: [],
    });
    expect(form.queryByText("Connection")).toBeNull();
    expect(form.getByText(MISSING_CONNECTION.message)).toBeTruthy();
  });

  it("shows the issue of a field its showWhen hides", async () => {
    const form = await renderStepForm({
      issues: [HIDDEN_FIELD_ISSUE],
      grants: [WfGraphOperations.workflowUpdate.id],
    });
    expect(form.queryByText("HTML body")).toBeNull();
    expect(form.getByText(HIDDEN_FIELD_ISSUE.message)).toBeTruthy();
  });
});
