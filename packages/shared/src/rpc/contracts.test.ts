import { describe, expect, it } from "vitest";
import {
  getWfGraphOperation,
  rpcContract,
  wfGraphOperationMeta,
} from "#src/rpc/contracts";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "#src/authorization/operations";
import type { WfGraphOperationId } from "#src/authorization/operations";
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
      .filter((id): id is WfGraphOperationId => id !== undefined);

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
