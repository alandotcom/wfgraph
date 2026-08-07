import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowToolbar } from "#src/components/workflow/workflow-toolbar";
import { orpcQuery } from "#src/lib/rpc-query";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";

vi.mock("#src/components/workflows/user-menu", () => ({
  UserMenu: () => null,
}));

vi.mock("#src/components/workflow/workflow-toolbar-chrome", () => ({
  DuplicateButton: () => null,
  ToolbarActions: () => null,
  WorkflowMenuComponent: () => null,
}));

vi.mock("#src/components/workflow/workflow-toolbar-handlers", () => ({
  useWorkflowActions: () => ({}),
  useWorkflowState: () => ({
    allWorkflows: [
      {
        id: "workflow_1",
        name: "Workflow",
        publishedVersionId: "version_1",
      },
    ],
    currentWorkflowId: "workflow_1",
    hasUnsavedChanges: false,
    isOwner: true,
    workflowMode: "live" as const,
  }),
}));

function seedPublication(
  queryClient: QueryClient,
  hasUnpublishedChanges: boolean
) {
  queryClient.setQueryData(
    orpcQuery.workflow.getById.queryKey({
      input: { workflowId: "workflow_1" },
    }),
    {
      id: "workflow_1",
      name: "Workflow",
      isPaused: false,
      mode: "live" as const,
      visibility: "private" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      publishedVersionId: "version_1",
      hasUnpublishedChanges,
      graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    }
  );
}

function renderToolbar(queryClient: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<WorkflowToolbar workflowId="workflow_1" />, { wrapper });
}

describe("workflow publication badge", () => {
  it("shows Unpublished changes when getById says the draft differs", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    seedPublication(queryClient, true);
    renderToolbar(queryClient);

    expect(screen.getByText("Unpublished changes")).toBeTruthy();
    expect(screen.queryByText("Published")).toBeNull();
  });

  it("shows Published when getById says the draft matches", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    seedPublication(queryClient, false);
    renderToolbar(queryClient);

    expect(screen.getByText("Published")).toBeTruthy();
    expect(screen.queryByText("Unpublished changes")).toBeNull();
  });
});
