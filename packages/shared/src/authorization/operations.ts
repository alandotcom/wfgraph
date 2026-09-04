/**
 * Authorization names shared by hosts, the RPC contract, and server routes.
 * Operation IDs name user-visible business actions; permissions group actions a
 * host commonly grants together.
 */

const permissionValues = [
  "workflow.read",
  "workflow.write",
  "run.read",
  "run.manage",
  "connection.read",
  "connection.write",
  "settings.read",
  "settings.write",
  "agent.use",
] as const;

export type WfGraphPermission = (typeof permissionValues)[number];

export const WfGraphPermissions = Object.freeze({
  workflowRead: "workflow.read",
  workflowWrite: "workflow.write",
  runRead: "run.read",
  runManage: "run.manage",
  connectionRead: "connection.read",
  connectionWrite: "connection.write",
  settingsRead: "settings.read",
  settingsWrite: "settings.write",
  agentUse: "agent.use",
} as const satisfies Record<string, WfGraphPermission>);

function operation<
  const TId extends string,
  const TPermission extends WfGraphPermission,
>(
  id: TId,
  permission: TPermission
): Readonly<{ id: TId; permission: TPermission }> {
  return Object.freeze({ id, permission });
}

const operationDefinitions = {
  agentChat: operation("agent.chat", WfGraphPermissions.agentUse),

  apiKeyGetAll: operation("apiKey.getAll", WfGraphPermissions.settingsRead),
  apiKeyCreate: operation("apiKey.create", WfGraphPermissions.settingsWrite),
  apiKeyDelete: operation("apiKey.delete", WfGraphPermissions.settingsWrite),

  integrationGetAll: operation(
    "integration.getAll",
    WfGraphPermissions.connectionRead
  ),
  integrationGet: operation(
    "integration.get",
    WfGraphPermissions.connectionRead
  ),
  integrationConfigOptions: operation(
    "integration.configOptions",
    WfGraphPermissions.connectionRead
  ),
  integrationCreate: operation(
    "integration.create",
    WfGraphPermissions.connectionWrite
  ),
  integrationUpdate: operation(
    "integration.update",
    WfGraphPermissions.connectionWrite
  ),
  integrationDelete: operation(
    "integration.delete",
    WfGraphPermissions.connectionWrite
  ),
  integrationDisconnectOAuth: operation(
    "integration.disconnectOAuth",
    WfGraphPermissions.connectionWrite
  ),
  integrationTestConnection: operation(
    "integration.testConnection",
    WfGraphPermissions.connectionWrite
  ),
  integrationTestCredentials: operation(
    "integration.testCredentials",
    WfGraphPermissions.connectionWrite
  ),

  workflowGetAll: operation("workflow.getAll", WfGraphPermissions.workflowRead),
  workflowGetById: operation(
    "workflow.getById",
    WfGraphPermissions.workflowRead
  ),
  workflowSubscribeList: operation(
    "workflow.subscribeList",
    WfGraphPermissions.workflowRead
  ),
  workflowSubscribeDraft: operation(
    "workflow.subscribeDraft",
    WfGraphPermissions.workflowRead
  ),
  workflowGetVersionHistory: operation(
    "workflow.getVersionHistory",
    WfGraphPermissions.workflowRead
  ),
  workflowGetVersionUsage: operation(
    "workflow.getVersionUsage",
    WfGraphPermissions.workflowRead
  ),
  workflowCompareVersion: operation(
    "workflow.compareVersion",
    WfGraphPermissions.workflowRead
  ),
  workflowGetCurrent: operation(
    "workflow.getCurrent",
    WfGraphPermissions.workflowRead
  ),
  workflowGetVersionGraph: operation(
    "workflow.getVersionGraph",
    WfGraphPermissions.workflowRead
  ),
  workflowCreate: operation(
    "workflow.create",
    WfGraphPermissions.workflowWrite
  ),
  workflowUpdate: operation(
    "workflow.update",
    WfGraphPermissions.workflowWrite
  ),
  workflowDelete: operation(
    "workflow.delete",
    WfGraphPermissions.workflowWrite
  ),
  workflowDuplicate: operation(
    "workflow.duplicate",
    WfGraphPermissions.workflowWrite
  ),
  workflowPublish: operation(
    "workflow.publish",
    WfGraphPermissions.workflowWrite
  ),
  workflowRestoreVersion: operation(
    "workflow.restoreVersion",
    WfGraphPermissions.workflowWrite
  ),
  workflowSaveCurrent: operation(
    "workflow.saveCurrent",
    WfGraphPermissions.workflowWrite
  ),
  workflowBulkLifecycle: operation(
    "workflow.bulkLifecycle",
    WfGraphPermissions.workflowWrite
  ),

  workflowExecute: operation("workflow.execute", WfGraphPermissions.runManage),
  workflowGetExecutions: operation(
    "workflow.getExecutions",
    WfGraphPermissions.runRead
  ),
  workflowGetExecutionsGlobal: operation(
    "workflow.getExecutionsGlobal",
    WfGraphPermissions.runRead
  ),
  workflowGetExecutionLogs: operation(
    "workflow.getExecutionLogs",
    WfGraphPermissions.runRead
  ),
  workflowGetExecutionEvents: operation(
    "workflow.getExecutionEvents",
    WfGraphPermissions.runRead
  ),
  workflowGetExecutionStatus: operation(
    "workflow.getExecutionStatus",
    WfGraphPermissions.runRead
  ),
  workflowDeleteExecutions: operation(
    "workflow.deleteExecutions",
    WfGraphPermissions.runManage
  ),
  workflowResumeWait: operation(
    "workflow.resumeWait",
    WfGraphPermissions.runManage
  ),
  workflowCancelExecution: operation(
    "workflow.cancelExecution",
    WfGraphPermissions.runManage
  ),

  oauthStart: operation("oauth.start", WfGraphPermissions.connectionWrite),
  oauthStatus: operation("oauth.status", WfGraphPermissions.connectionWrite),
  oauthCallback: operation(
    "oauth.callback",
    WfGraphPermissions.connectionWrite
  ),
} as const;

export const WfGraphOperations = Object.freeze(operationDefinitions);

export type WfGraphOperation =
  (typeof operationDefinitions)[keyof typeof operationDefinitions];

export type WfGraphOperationId = WfGraphOperation["id"];

export const WfGraphOperationIds = Object.freeze(
  Object.values(WfGraphOperations).map((entry) => entry.id)
);
