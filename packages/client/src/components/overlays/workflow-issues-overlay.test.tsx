import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createStore, Provider as JotaiProvider } from "jotai";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { WorkflowIssuesOverlay } from "#src/components/overlays/workflow-issues-overlay";
import type { WorkflowIssuesOverlayModel } from "@wfgraph/shared/graph/workflow-issues";
import {
  loadWorkflowGraphAtom,
  nodesAtom,
  repairIntegrationsAtom,
} from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssueCount } from "#src/components/overlays/workflow-issues-overlay";

/**
 * The issues dialog's Add button creates a connection and then repairs the
 * open graph against the refreshed list. The repair itself is this atom; the
 * overlay only calls it. What used to be covered by mocking the credential form
 * is the write that points unbound nodes at the new connection.
 */

const ACTION = "linear/find-issues";

const linearCatalog = {
  events: [],
  actions: [
    {
      id: ACTION,
      label: "Find Issues",
      description: "Find issues matching a filter",
      category: "Linear",
      integration: "linear",
      configFields: [],
      outputFields: [],
    },
  ],
  integrations: [
    {
      type: "linear",
      label: "Linear",
      description: "Linear issue tracking",
      credentialFields: {},
      hasTest: true,
    },
  ],
};

const unboundNode: WorkflowNode = {
  id: "node_1",
  type: "action",
  position: { x: 0, y: 0 },
  data: {
    label: "Did they reschedule?",
    type: "action",
    config: { actionType: ACTION },
  },
};

describe("repairIntegrationsAtom", () => {
  it("binds flagged nodes to a connection that now exists", () => {
    const store = createStore();
    store.set(loadWorkflowGraphAtom, { nodes: [unboundNode], edges: [] });

    store.set(repairIntegrationsAtom, {
      integrations: [{ id: "int_linear", type: "linear" }],
      catalog: linearCatalog,
    });

    expect(store.get(nodesAtom)[0]?.data.config?.integrationId).toBe(
      "int_linear"
    );
  });
});

describe("workflowIssueCount", () => {
  it("counts issue instances rather than grouped rows", () => {
    expect(
      workflowIssueCount({
        totalIssues: 6,
        missingIntegrations: [
          {
            integrationType: "linear",
            integrationLabel: "Linear",
            nodeNames: ["Find issues", "Create issue"],
          },
        ],
        brokenReferences: [
          {
            nodeId: "notify",
            nodeLabel: "Notify",
            brokenReferences: [
              {
                fieldKey: "message",
                fieldLabel: "Message",
                referencedNodeId: "missing-a",
                displayText: "Missing A",
              },
              {
                fieldKey: "channel",
                fieldLabel: "Channel",
                referencedNodeId: "missing-b",
                displayText: "Missing B",
              },
            ],
          },
        ],
        missingRequiredFields: [
          {
            nodeId: "send",
            nodeLabel: "Send",
            missingFields: [
              { fieldKey: "to", fieldLabel: "To" },
              { fieldKey: "subject", fieldLabel: "Subject" },
            ],
          },
        ],
        unverifiedProviderFields: [
          {
            nodeId: "create",
            nodeLabel: "Create issue",
            fields: [{ fieldKey: "fields", fieldLabel: "Fields" }],
          },
        ],
      })
    ).toBe(6);
  });
});

/** The list as the overlay is handed it, with only the rows a case needs. */
function issuesModel(
  overrides: Partial<WorkflowIssuesOverlayModel>
): WorkflowIssuesOverlayModel {
  return {
    totalIssues: 0,
    missingIntegrations: [],
    brokenReferences: [],
    missingRequiredFields: [],
    unverifiedProviderFields: [],
    ...overrides,
  };
}

function renderIssues(issues: WorkflowIssuesOverlayModel) {
  return render(
    <JotaiProvider store={createStore()}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ExtensionCatalogProvider value={linearCatalog}>
          {/* The missing-connection rows draw an integration icon. */}
          <IntegrationUiProvider value={{}}>
            <OverlayProvider>
              <WorkflowIssuesOverlay
                issues={issues}
                onGoToStep={() => {}}
                overlayId="issues"
              />
            </OverlayProvider>
          </IntegrationUiProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
}

describe("WorkflowIssuesOverlay", () => {
  // The strip's chip says "2 issues" and this list opens from it, so the two
  // read the same. It used to head itself "Workflow Issues (2)".
  it("heads itself with the count the chip carries", () => {
    const { getAllByRole, getByText } = renderIssues(
      issuesModel({
        totalIssues: 2,
        brokenReferences: [
          {
            nodeId: "notify",
            nodeLabel: "Notify",
            brokenReferences: [
              {
                fieldKey: "message",
                fieldLabel: "Message",
                referencedNodeId: "missing-a",
                displayText: "Missing A",
              },
              {
                fieldKey: "channel",
                fieldLabel: "Channel",
                referencedNodeId: "missing-b",
                displayText: "Missing B",
              },
            ],
          },
        ],
      })
    );

    expect(getByText("2 issues")).toBeTruthy();
    // Nothing blocking, so the softer sentence is the only one, and Close
    // leaves the filled button to the repairs in the list.
    expect(
      getByText("The draft has issues that may cause it to fail.")
    ).toBeTruthy();
    // The footer's Close, rather than the header's icon of the same name.
    const close = getAllByRole("button", { name: "Close" }).find(
      (button) => button.textContent === "Close"
    );
    expect(close?.className).toContain("border-border");
  });

  // One line, not two: a reader with a blocking issue needs the harder fact,
  // and the pair of them put the softer one first.
  it("says only the blocker while one stands", () => {
    const { getByRole, getByText, queryByText } = renderIssues(
      issuesModel({
        totalIssues: 1,
        missingIntegrations: [
          {
            integrationType: "linear",
            integrationLabel: "Linear",
            nodeNames: ["Find issues"],
          },
        ],
      })
    );

    expect(
      getByText("Resolve blocking issues before running the draft.")
    ).toBeTruthy();
    expect(
      queryByText("The draft has issues that may cause it to fail.")
    ).toBeNull();
    // The one repair on offer is the filled button.
    expect(getByRole("button", { name: "Add" }).className).toContain(
      "bg-primary"
    );
  });
});
