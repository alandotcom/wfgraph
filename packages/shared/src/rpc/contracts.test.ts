import { describe, expect, it } from "vitest";
import { rpcContract } from "#src/rpc/contracts";
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
