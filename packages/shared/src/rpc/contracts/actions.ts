import { Schema } from "effect";
import { WfGraphOperations } from "#src/authorization/operations";
import {
  actionOptionsConfigSchema,
  configOptionsAnswerSchema,
  configOptionsProviderNameSchema,
} from "#src/rpc/contracts/config-options";
import { contractSchema, route } from "#src/rpc/contracts/contract-support";
import { NonEmptyTrimmedString } from "#src/types/schema";

/** Procedures owned by host-defined actions. */
export const actionContract = {
  configOptions: route(
    "POST",
    "/actions/{actionId}/config-options",
    WfGraphOperations.actionConfigOptions
  )
    .input(
      contractSchema(
        Schema.Struct({
          actionId: NonEmptyTrimmedString,
          provider: configOptionsProviderNameSchema(),
          parameters: Schema.optionalKey(actionOptionsConfigSchema()),
        })
      )
    )
    .output(contractSchema(configOptionsAnswerSchema())),
};
