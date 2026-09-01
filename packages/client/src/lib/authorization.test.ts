import { afterEach, describe, expect, it } from "vitest";
import { can } from "#src/lib/authorization";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

afterEach(() => {
  resetAuthorizationGrantsForTests();
});

describe("authorization bootstrap", () => {
  it("denies operations before a grant snapshot is installed", () => {
    expect(can(WfGraphOperations.workflowUpdate.id)).toBe(false);
  });

  it("answers grants synchronously from the installed snapshot", () => {
    installAuthorizationGrantsForTests([
      WfGraphOperations.workflowUpdate.id,
      WfGraphOperations.workflowPublish.id,
    ]);

    expect(can(WfGraphOperations.workflowUpdate.id)).toBe(true);
    expect(can(WfGraphOperations.workflowDelete.id)).toBe(false);
  });

  it("copies the installed operation list", () => {
    const operationIds = [WfGraphOperations.workflowUpdate.id];
    installAuthorizationGrantsForTests(operationIds);

    operationIds.length = 0;

    expect(can(WfGraphOperations.workflowUpdate.id)).toBe(true);
  });
});
