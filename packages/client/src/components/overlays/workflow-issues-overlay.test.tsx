import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  entities: [],
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
      hasWebhook: false,
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
        draftRunBlockingCount: 0,
        publishBlockingCount: 0,
        invalidGroups: [],
        invalidLifecycleRules: [],
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

/** Builds the model the overlay takes, filling only the rows a case needs. */
function issuesModel(
  overrides: Partial<WorkflowIssuesOverlayModel>
): WorkflowIssuesOverlayModel {
  return {
    totalIssues: 0,
    draftRunBlockingCount: 0,
    publishBlockingCount: 0,
    invalidGroups: [],
    invalidLifecycleRules: [],
    missingIntegrations: [],
    brokenReferences: [],
    missingRequiredFields: [],
    unverifiedProviderFields: [],
    ...overrides,
  };
}

function renderIssues(
  issues: WorkflowIssuesOverlayModel,
  options: {
    onGoToStep?: ((nodeId: string, fieldKey?: string) => void) | undefined;
    trigger?: "run" | "publish" | "list" | undefined;
  } = {}
) {
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
                trigger={options.trigger ?? "run"}
                onGoToStep={options.onGoToStep ?? (() => {})}
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
  // The strip's chip says "2 issues" and this list opens from it, so both use
  // the same wording. The heading used to read "Workflow Issues (2)".
  it("heads the list with the count the chip shows", () => {
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
    // No blocking issue, so only the warning sentence appears.
    expect(
      getByText("The draft has issues that might cause the run to fail.")
    ).toBeTruthy();
    // The footer's Close, rather than the header's icon of the same name. It is
    // an outline button, like every repair in the list: the dialog fills none.
    const close = getAllByRole("button", { name: "Close" }).find(
      (button) => button.textContent === "Close"
    );
    expect(close?.className).toContain("border-border");
    expect(close?.className).not.toContain("bg-primary");
  });

  // A blocking issue shows one sentence on its own. Showing both would put the
  // warning sentence ahead of the fact the reader needs.
  it("shows only the blocking sentence while a blocker stands", () => {
    const { getByRole, getByText, queryByText } = renderIssues(
      issuesModel({
        totalIssues: 1,
        draftRunBlockingCount: 1,
        publishBlockingCount: 1,
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
      queryByText("The draft has issues that might cause the run to fail.")
    ).toBeNull();
    // Every repair wears the same outline weight, whether it is the first row
    // or the fifth.
    expect(
      getByRole("button", { name: "Add Connection for Linear" }).className
    ).toContain("border-border");
    expect(
      getByRole("button", { name: "Add Connection for Linear" }).className
    ).not.toContain("bg-primary");
  });

  // Publish refused by an issue that also stops a draft run names Publish, the
  // action the person took.
  it("names Publish when a blocker stopped Publish", () => {
    const { getByText, queryByText } = renderIssues(
      issuesModel({
        totalIssues: 1,
        draftRunBlockingCount: 1,
        publishBlockingCount: 1,
        missingIntegrations: [
          {
            integrationType: "linear",
            integrationLabel: "Linear",
            nodeNames: ["Find issues"],
          },
        ],
      }),
      { trigger: "publish" }
    );

    expect(getByText("Fix these issues before publishing.")).toBeTruthy();
    expect(
      queryByText("Resolve blocking issues before running the draft.")
    ).toBeNull();
  });

  // A Group problem stops Publish and leaves the draft run free, so its sentence
  // names Publish and the Group's own name heads its messages.
  it("lists a Group's rule messages under the Group and says the draft can run", () => {
    const { getByRole, getByText, queryByText } = renderIssues(
      issuesModel({
        totalIssues: 1,
        publishBlockingCount: 1,
        invalidGroups: [
          {
            nodeId: "group-1",
            nodeLabel: "Lookups",
            problems: [
              {
                rule: "too_few_members",
                message: 'Group "Lookups" needs at least two steps',
              },
            ],
          },
        ],
      })
    );

    expect(getByText("Group Problems")).toBeTruthy();
    expect(getByText("Lookups")).toBeTruthy();
    expect(getByText('Group "Lookups" needs at least two steps')).toBeTruthy();
    expect(
      getByText(
        "Resolve the blocking issues before publishing. The draft can still run."
      )
    ).toBeTruthy();
    expect(
      queryByText("Resolve blocking issues before running the draft.")
    ).toBeNull();
    expect(getByRole("button", { name: "Open Lookups" })).toBeTruthy();
  });

  it("lists a Lifecycle Node's Publish problems and opens the node", () => {
    const onGoToStep = vi.fn();
    const { getByRole, getByText } = renderIssues(
      issuesModel({
        totalIssues: 1,
        publishBlockingCount: 1,
        invalidLifecycleRules: [
          {
            nodeId: "lifecycle",
            nodeLabel: "Lifecycle",
            problems: [
              {
                check: "start_filter",
                message: "Start Filter reads an undeclared path",
              },
            ],
          },
        ],
      }),
      { onGoToStep }
    );

    expect(getByText("Lifecycle Problems")).toBeTruthy();
    expect(getByText("Start Filter reads an undeclared path")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Open Lifecycle" }));
    expect(onGoToStep).toHaveBeenCalledWith("lifecycle", undefined);
  });

  it("gives direct recovery actions for fields that were not verified", () => {
    const onGoToStep = vi.fn();
    const { getByRole, getByText } = renderIssues(
      issuesModel({
        totalIssues: 1,
        unverifiedProviderFields: [
          {
            nodeId: "create",
            nodeLabel: "Create issue",
            fields: [{ fieldKey: "fields", fieldLabel: "Fields" }],
          },
        ],
      }),
      { onGoToStep }
    );

    expect(
      getByText(
        "The Connection did not respond, so these fields were not verified."
      )
    ).toBeTruthy();
    expect(
      getByText("Reconnect the Connection in Settings to verify them again.")
    ).toBeTruthy();
    fireEvent.click(
      getByRole("button", { name: "Review Fields in Create issue" })
    );
    expect(onGoToStep).toHaveBeenCalledWith("create", "fields");
  });
});
