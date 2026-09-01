import { describe, expect, expectTypeOf, it } from "vitest";
import {
  WfGraphOperationIds,
  WfGraphOperations,
  WfGraphRolePresets,
  WfGraphPermissions,
} from "#src/authorization/operations";
import type {
  WfGraphOperation,
  WfGraphOperationId,
} from "#src/authorization/operations";

const operationIds = new Set<WfGraphOperationId>(WfGraphOperationIds);

function assertNever(value: never): never {
  throw new Error(`Unexpected operation ID: ${String(value)}`);
}

function returnKnownOperationId(id: WfGraphOperationId): WfGraphOperationId {
  switch (id) {
    case "agent.chat":
    case "apiKey.getAll":
    case "apiKey.create":
    case "apiKey.delete":
    case "integration.getAll":
    case "integration.get":
    case "integration.configOptions":
    case "integration.create":
    case "integration.update":
    case "integration.delete":
    case "integration.disconnectOAuth":
    case "integration.testConnection":
    case "integration.testCredentials":
    case "workflow.getAll":
    case "workflow.getById":
    case "workflow.getVersionHistory":
    case "workflow.compareVersion":
    case "workflow.getCurrent":
    case "workflow.getVersionGraph":
    case "workflow.create":
    case "workflow.update":
    case "workflow.delete":
    case "workflow.duplicate":
    case "workflow.publish":
    case "workflow.restoreVersion":
    case "workflow.saveCurrent":
    case "workflow.bulkLifecycle":
    case "workflow.execute":
    case "workflow.getExecutions":
    case "workflow.getExecutionsGlobal":
    case "workflow.getExecutionLogs":
    case "workflow.getExecutionEvents":
    case "workflow.getExecutionStatus":
    case "workflow.deleteExecutions":
    case "workflow.resumeWait":
    case "workflow.cancelExecution":
    case "oauth.start":
    case "oauth.status":
    case "oauth.callback":
      return id;
    default:
      return assertNever(id);
  }
}

describe("Workflow Graph authorization operations", () => {
  it("defines the fixed permission vocabulary", () => {
    expect(WfGraphPermissions).toEqual({
      workflowRead: "workflow.read",
      workflowWrite: "workflow.write",
      runRead: "run.read",
      runManage: "run.manage",
      connectionRead: "connection.read",
      connectionWrite: "connection.write",
      settingsRead: "settings.read",
      settingsWrite: "settings.write",
      agentUse: "agent.use",
    });
  });

  it("defines immutable coherent role presets", () => {
    expect(WfGraphRolePresets.read).toEqual([
      "workflow.read",
      "run.read",
      "connection.read",
    ]);
    expect(WfGraphRolePresets.readWrite).toEqual([
      "workflow.read",
      "run.read",
      "connection.read",
      "workflow.write",
      "run.manage",
      "agent.use",
    ]);
    expect(WfGraphRolePresets.admin).toEqual(Object.values(WfGraphPermissions));
    expect(Object.isFrozen(WfGraphRolePresets)).toBe(true);
    expect(Object.isFrozen(WfGraphRolePresets.admin)).toBe(true);
  });

  it("gives every protected operation a stable unique id", () => {
    expect(WfGraphOperationIds).toEqual(
      expect.arrayContaining([
        "agent.chat",
        "apiKey.getAll",
        "integration.getAll",
        "workflow.getAll",
        "workflow.execute",
        "oauth.start",
        "oauth.status",
        "oauth.callback",
      ])
    );
    expect(new Set(WfGraphOperationIds).size).toBe(WfGraphOperationIds.length);
    expect(WfGraphOperations.workflowExecute.permission).toBe("run.manage");
  });

  it("keeps operation IDs closed and operation permissions exact at compile time", () => {
    expect(operationIds.has(WfGraphOperations.workflowExecute.id)).toBe(true);
    expect(returnKnownOperationId(WfGraphOperations.oauthCallback.id)).toBe(
      "oauth.callback"
    );
    expectTypeOf<WfGraphOperation["id"]>().toEqualTypeOf<WfGraphOperationId>();
    expectTypeOf(WfGraphOperations.workflowExecute).toEqualTypeOf<{
      readonly id: "workflow.execute";
      readonly permission: "run.manage";
    }>();
  });
});
