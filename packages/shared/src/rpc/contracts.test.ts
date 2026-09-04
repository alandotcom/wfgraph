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

describe("integration RPC input contracts", () => {
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
