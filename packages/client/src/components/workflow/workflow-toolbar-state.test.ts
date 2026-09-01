import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowToolbarCapabilities } from "#src/components/workflow/workflow-toolbar-state";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

afterEach(() => {
  resetAuthorizationGrantsForTests();
});

describe("readWorkflowToolbarCapabilities", () => {
  it("keeps published execution available without draft updates", () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowExecute.id,
      WfGraphOperations.workflowGetVersionGraph.id,
    ]);

    expect(readWorkflowToolbarCapabilities()).toMatchObject({
      canExecute: true,
      canReadVersionGraph: true,
      canUpdate: false,
    });
  });

  it("hides runs until every run-inspection read is granted", () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowGetExecutions.id,
      WfGraphOperations.workflowGetExecutionLogs.id,
      WfGraphOperations.workflowGetExecutionEvents.id,
      WfGraphOperations.workflowGetExecutionStatus.id,
    ]);

    expect(readWorkflowToolbarCapabilities().canReadRuns).toBe(false);

    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowGetExecutions.id,
      WfGraphOperations.workflowGetExecutionLogs.id,
      WfGraphOperations.workflowGetExecutionEvents.id,
      WfGraphOperations.workflowGetExecutionStatus.id,
      WfGraphOperations.workflowGetVersionGraph.id,
    ]);

    expect(readWorkflowToolbarCapabilities().canReadRuns).toBe(true);
  });

  it("requires comparison access before offering publish", () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowPublish.id]);

    expect(readWorkflowToolbarCapabilities()).toMatchObject({
      canPublish: false,
      canExecute: false,
      canUpdate: false,
    });

    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowPublish.id,
      WfGraphOperations.workflowCompareVersion.id,
    ]);

    expect(readWorkflowToolbarCapabilities().canPublish).toBe(true);
  });

  it("allows workflow creation independently of the open workflow", () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowCreate.id]);

    expect(readWorkflowToolbarCapabilities()).toMatchObject({
      canCreate: true,
      canDuplicate: false,
      canDelete: false,
    });
  });

  it("allows duplication independently of updates and deletion", () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowDuplicate.id,
    ]);

    expect(readWorkflowToolbarCapabilities()).toMatchObject({
      canDuplicate: true,
      canUpdate: false,
      canDelete: false,
    });
  });

  it("allows deletion independently of updates and duplication", () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowDelete.id]);

    expect(readWorkflowToolbarCapabilities()).toMatchObject({
      canDelete: true,
      canUpdate: false,
      canDuplicate: false,
    });
  });
});
