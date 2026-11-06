import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isNotNil } from "es-toolkit/predicate";
import {
  getWfGraphOperation,
  rpcContract,
  wfGraphOperationMeta,
} from "#src/rpc/contracts";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "#src/authorization/operations";
import { RESERVED_RECORD_KEYS } from "#src/types/record-key";

type ValidationResult =
  | { readonly value: unknown }
  | { readonly issues: readonly unknown[] };

type ContractWithInput = {
  readonly "~orpc": {
    readonly inputSchemas: readonly [
      {
        readonly "~standard": {
          readonly validate: (
            value: unknown
          ) => ValidationResult | Promise<ValidationResult>;
        };
      },
    ];
  };
};

async function validateInput(
  contract: unknown,
  input: unknown
): Promise<ValidationResult> {
  const schema = (contract as ContractWithInput)["~orpc"].inputSchemas[0];
  return await schema["~standard"].validate(input);
}

function getOutputDecoder(contract: {
  readonly "~orpc": {
    readonly outputSchemas?: readonly unknown[] | undefined;
  };
}): (value: unknown) => Promise<ValidationResult> {
  const schema = contract["~orpc"].outputSchemas?.[0] as
    | StandardSchemaV1
    | undefined;
  if (!schema) {
    throw new Error("The contract must declare an output schema");
  }
  return async (value) => await schema["~standard"].validate(value);
}

describe("action RPC input contracts", () => {
  it("accepts every schema field in a host option draft", async () => {
    const parameters = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`field${index}`, `${index}`])
    );
    const result = await validateInput(rpcContract.action.configOptions, {
      actionId: "host/template-email",
      provider: "templates",
      parameters,
    });

    expect(result).toHaveProperty("value");
  });

  it("accepts long sibling values in a host option draft", async () => {
    const result = await validateInput(rpcContract.action.configOptions, {
      actionId: "host/template-email",
      provider: "templates",
      parameters: {
        messageBody: "x".repeat(2049),
        templateId: "welcome",
      },
    });

    expect(result).toHaveProperty("value");
  });

  it.each(RESERVED_RECORD_KEYS)(
    "rejects the reserved config-options parameter key %s",
    async (key) => {
      const result = await validateInput(rpcContract.action.configOptions, {
        actionId: "host/template-email",
        provider: "templates",
        parameters: Object.fromEntries([[key, "forged"]]),
      });

      expect(result).toHaveProperty("issues");
    }
  );
});

describe("integration RPC input contracts", () => {
  it("keeps the eight-dependency cap for integration providers", async () => {
    const parameters = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`field${index}`, `${index}`])
    );
    const result = await validateInput(rpcContract.integration.configOptions, {
      integrationId: "int_1",
      provider: "templates",
      parameters,
    });

    expect(result).toHaveProperty("issues");
  });

  it.each(RESERVED_RECORD_KEYS)(
    "rejects the reserved create config key %s",
    async (key) => {
      const result = await validateInput(rpcContract.integration.create, {
        name: "Example",
        type: "example",
        config: Object.fromEntries([[key, "forged"]]),
      });

      expect(result).toHaveProperty("issues");
    }
  );

  it.each(RESERVED_RECORD_KEYS)(
    "rejects the reserved update config key %s",
    async (key) => {
      const result = await validateInput(rpcContract.integration.update, {
        integrationId: "int_1",
        config: Object.fromEntries([[key, "forged"]]),
      });

      expect(result).toHaveProperty("issues");
    }
  );

  it.each(RESERVED_RECORD_KEYS)(
    "rejects the reserved config-options parameter key %s",
    async (key) => {
      const result = await validateInput(
        rpcContract.integration.configOptions,
        {
          integrationId: "int_1",
          provider: "templates",
          parameters: Object.fromEntries([[key, "forged"]]),
        }
      );

      expect(result).toHaveProperty("issues");
    }
  );
});

describe("workflow executions RPC output contract", () => {
  it("carries cancellation delivery failures separately from refused starts", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.getExecutions);

    const result = await decode({
      items: [],
      supersededCount: 0,
      refusedStarts: [
        {
          id: "evt_start_1",
          message: "Start Filter declined the event",
          createdAt: "2026-03-01T09:59:00.000Z",
        },
      ],
      cancelNotDelivered: [
        {
          id: "evt_cancel_1",
          message: "Cancel Filter declined the event",
          createdAt: "2026-03-01T09:58:00.000Z",
        },
      ],
    });

    expect(result).toHaveProperty("value");
  });

  const listItem = {
    id: "exec_1",
    workflowId: "wf_1",
    status: "running",
    startSource: "manual",
    runMode: "live",
    startEventName: null,
    entityValue: null,
    versionKind: "published",
    versionNumber: 1,
    error: null,
    startedAt: "2026-03-01T09:00:00.000Z",
    waitingAt: null,
    cancelledAt: null,
    completedAt: null,
    duration: null,
  };

  it("carries each kind of executor activity on a list row, and none", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.getExecutions);
    const activities = [
      null,
      {
        kind: "retrying",
        nodeId: "send",
        nodeName: "Send reminder",
        nextTryAt: "2026-03-01T09:01:00.000Z",
        failures: 2,
        retryLimit: 4,
        error: "send is down",
      },
      {
        kind: "retrying",
        nodeId: null,
        nodeName: null,
        nextTryAt: "2026-03-01T09:01:00.000Z",
        failures: 1,
        retryLimit: 4,
        error: null,
      },
      {
        kind: "lease_expired",
        nodeId: "send",
        nodeName: null,
        since: "2026-03-01T09:00:30.000Z",
      },
      {
        kind: "unclaimed",
        dueSince: "2026-03-01T09:00:00.000Z",
        observedAt: "2026-03-01T09:02:00.000Z",
      },
    ];

    const result = await decode({
      items: activities.map((activity) => ({ ...listItem, activity })),
      supersededCount: 0,
      refusedStarts: [],
      cancelNotDelivered: [],
    });

    expect(result).toHaveProperty("value");
  });

  it("refuses an activity instant that is not an ISO timestamp", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.getExecutionsGlobal);

    const result = await decode({
      items: [
        {
          ...listItem,
          workflowName: "Onboarding",
          workflowIsPaused: false,
          activity: {
            kind: "unclaimed",
            dueSince: "yesterday",
            observedAt: "2026-03-01T09:02:00.000Z",
          },
        },
      ],
      nextCursor: null,
    });

    expect(result).toHaveProperty("issues");
  });
});

describe("workflow execution logs RPC output contract", () => {
  const payload = {
    execution: {
      id: "exec_1",
      workflowId: "wf_1",
      workflowVersionId: "ver_1",
      versionKind: "published",
      versionNumber: 1,
      status: "running",
      startSource: "manual",
      runMode: "live",
      startEventName: null,
      entityValue: null,
      input: {},
      output: null,
      error: null,
      startedAt: "2026-03-01T09:00:00.000Z",
      completedAt: null,
      duration: null,
    },
    logs: [
      {
        id: "log_1",
        executionId: "exec_1",
        nodeId: "send",
        nodeName: "Send reminder",
        nodeType: "action",
        status: "success",
        input: {},
        output: {},
        error: null,
        startedAt: "2026-03-01T09:00:00.000Z",
        completedAt: "2026-03-01T09:00:05.000Z",
        duration: "5000",
        retries: 2,
      },
    ],
    waits: [],
    exit: null,
  };

  it("carries the executor's hold on an in-progress run, and null once it ended", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.getExecutionLogs);
    const schedule = {
      observedAt: "2026-03-01T09:02:00.000Z",
      activity: {
        kind: "running",
        nodeId: "send",
        nodeName: "Send reminder",
        workerId: "worker_1",
      },
      state: "leased",
      wakeAt: "2026-03-01T09:01:00.000Z",
      attempt: 0,
      retryLimit: 4,
      runningStepId: "node:send:dispatch",
      runningNodeId: "send",
      runningNodeName: "Send reminder",
      leaseExpiresAt: "2026-03-01T09:03:00.000Z",
      workerId: "worker_1",
      lastError: "send is down",
      failingSteps: [
        {
          stepId: "node:send:dispatch",
          nodeId: "send",
          nodeName: "Send reminder",
          failures: 1,
          error: "send is down",
        },
      ],
      unconsumedWakes: [
        {
          waitStateId: "wait_1",
          nodeId: "approval",
          nodeName: "Approval",
          kind: "resume",
          eventName: "app/approved",
          wokenAt: "2026-03-01T09:01:30.000Z",
        },
      ],
    };

    expect(await decode({ ...payload, schedule })).toHaveProperty("value");
    expect(await decode({ ...payload, schedule: null })).toHaveProperty(
      "value"
    );
  });

  it("carries each case of the server's decision about the run, and none", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.getExecutionLogs);
    const activities = [
      null,
      {
        kind: "resuming",
        nodeId: "approval",
        nodeName: "Approval",
        wake: "resume",
        eventName: "app/approved",
        wokenAt: "2026-03-01T09:01:30.000Z",
        deadline: null,
        unclaimedSince: "2026-03-01T09:01:30.000Z",
      },
      {
        kind: "lease_expired",
        nodeId: null,
        nodeName: null,
        since: "2026-03-01T09:00:30.000Z",
      },
      { kind: "running", nodeId: null, nodeName: null, workerId: null },
      {
        kind: "retrying",
        nodeId: null,
        nodeName: null,
        nextTryAt: "2026-03-01T09:03:00.000Z",
        failures: 1,
        retryLimit: 4,
        error: "the body failed",
      },
      { kind: "unclaimed", dueSince: "2026-03-01T09:00:00.000Z" },
      { kind: "waiting" },
    ];

    for (const activity of activities) {
      const schedule = {
        observedAt: "2026-03-01T09:02:00.000Z",
        activity,
        state: "queued",
        wakeAt: "2026-03-01T09:01:00.000Z",
        attempt: 0,
        retryLimit: 4,
        runningStepId: null,
        runningNodeId: null,
        runningNodeName: null,
        leaseExpiresAt: null,
        workerId: null,
        lastError: null,
        failingSteps: [],
        unconsumedWakes: [],
      };
      expect(await decode({ ...payload, schedule })).toHaveProperty("value");
    }
  });

  it("refuses a node log without its retry count", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.getExecutionLogs);
    const [log] = payload.logs;

    const result = await decode({
      ...payload,
      logs: [{ ...log, retries: undefined }],
      schedule: null,
    });

    expect(result).toHaveProperty("issues");
  });
});

describe("workflow execution status RPC output contract", () => {
  it("carries the retrying nodes beside the open waits", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.getExecutionStatus);

    const result = await decode({
      status: "running",
      nodeStatuses: [{ nodeId: "send", status: "running" }],
      openWaitNodeIds: [],
      retryingNodeIds: ["send"],
    });

    expect(result).toHaveProperty("value");
  });
});

describe("workflow migration RPC contracts", () => {
  it("accepts a preview request that names no target version", async () => {
    const result = await validateInput(rpcContract.workflow.previewMigration, {
      workflowId: "workflow_1",
    });

    expect(result).toHaveProperty("value");
  });

  it("rejects a migrate request that names no target version", async () => {
    const result = await validateInput(rpcContract.workflow.migrateExecutions, {
      workflowId: "workflow_1",
      executionIds: ["exec_1"],
    });

    expect(result).toHaveProperty("issues");
  });

  it("carries a migrated run and a refused run in one report", async () => {
    const decode = getOutputDecoder(rpcContract.workflow.migrateExecutions);

    const result = await decode({
      targetVersionId: "version_2",
      targetVersionNumber: 2,
      outcomes: [
        { executionId: "exec_1", status: "migrated" },
        {
          executionId: "exec_2",
          status: "refused",
          reason: "executing",
        },
      ],
    });

    expect(result).toHaveProperty("value");
  });
});

describe("workflow draft subscription RPC input contract", () => {
  it("accepts the last locally loaded revision, including the initial zero", async () => {
    const result = await validateInput(rpcContract.workflow.subscribeDraft, {
      workflowId: "workflow_1",
      afterDraftRevision: 0,
    });

    expect(result).toHaveProperty("value");
  });

  it("rejects a negative revision cursor", async () => {
    const result = await validateInput(rpcContract.workflow.subscribeDraft, {
      workflowId: "workflow_1",
      afterDraftRevision: -1,
    });

    expect(result).toHaveProperty("issues");
  });
});

describe("authorization metadata", () => {
  it("exports the operation metadata definition used by RPC adapters", () => {
    expect(wfGraphOperationMeta).toBeTypeOf("function");
  });

  it("annotates every protected contract procedure with a canonical operation", () => {
    const procedures = Object.values(rpcContract).flatMap((group) =>
      Object.values(group)
    );
    const operationIds = procedures
      .map((procedure) => getWfGraphOperation(procedure)?.id)
      .filter(isNotNil);

    expect(operationIds.sort()).toEqual(
      WfGraphOperationIds.filter((id) => !id.startsWith("oauth.")).sort()
    );
  });

  it("uses the canonical operation ID and permission in OpenAPI metadata", () => {
    const procedure = rpcContract.workflow.getAll as unknown as {
      "~orpc": {
        meta: {
          "~openapi": {
            operationId: string;
            spec: (
              operation: Record<string, unknown>
            ) => Record<string, unknown>;
          };
        };
      };
    };
    const openApi = procedure["~orpc"].meta["~openapi"];

    expect(openApi.operationId).toBe(WfGraphOperations.workflowGetAll.id);
    expect(openApi.spec({})["x-wfgraph-permission"]).toBe(
      WfGraphOperations.workflowGetAll.permission
    );
  });
});
