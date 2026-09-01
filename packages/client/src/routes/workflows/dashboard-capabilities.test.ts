import { afterEach, describe, expect, it } from "vitest";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { readDashboardCapabilities } from "#src/routes/workflows/dashboard-capabilities";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

afterEach(resetAuthorizationGrantsForTests);

describe("dashboard capabilities", () => {
  it("keeps workflow rows static when the workflow detail grant is absent", () => {
    installAuthorizationGrantsForTests([WfGraphOperations.workflowGetAll.id]);

    expect(readDashboardCapabilities()).toEqual({
      canOpenWorkflow: false,
      canOpenGlobalRuns: false,
    });
  });

  it("hides global runs until every editor run-detail read is granted", () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowGetById.id,
      WfGraphOperations.workflowGetExecutionsGlobal.id,
      WfGraphOperations.workflowGetExecutions.id,
      WfGraphOperations.workflowGetExecutionLogs.id,
      WfGraphOperations.workflowGetExecutionEvents.id,
      WfGraphOperations.workflowGetExecutionStatus.id,
    ]);

    expect(readDashboardCapabilities()).toMatchObject({
      canOpenWorkflow: true,
      canOpenGlobalRuns: false,
    });
  });
});
