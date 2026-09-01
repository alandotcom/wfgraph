import { Schema } from "effect";
import { WfGraphOperations } from "#src/authorization/operations";
import { listOf } from "#src/types/schema";
import {
  contractSchema,
  deleted,
  idSchema,
  noInput,
  route,
} from "#src/rpc/contracts/contract-support";

const apiKeyFields = {
  id: idSchema,
  name: Schema.NullOr(Schema.String),
  keyPrefix: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
};

export const apiKeyContract = {
  getAll: route("GET", "/api-keys", WfGraphOperations.apiKeyGetAll)
    .input(noInput)
    .output(contractSchema(listOf(Schema.Struct(apiKeyFields)))),
  create: route("POST", "/api-keys", WfGraphOperations.apiKeyCreate)
    .input(
      contractSchema(
        Schema.Struct({
          name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        })
      )
    )
    .output(
      contractSchema(Schema.Struct({ ...apiKeyFields, key: Schema.String }))
    ),
  delete: route("DELETE", "/api-keys/{keyId}", WfGraphOperations.apiKeyDelete)
    .input(contractSchema(Schema.Struct({ keyId: idSchema })))
    .output(deleted),
};
