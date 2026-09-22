import { Schema } from "effect";
import { WfGraphOperations } from "#src/authorization/operations";
import { OAUTH_GRANT_CONFIG_KEY } from "#src/types/integration";
import { hasOnlySafeRecordKeys } from "#src/types/record-key";
import { NonEmptyTrimmedString, listOf } from "#src/types/schema";
import { isoTimestampString } from "#src/types/timestamp";
import {
  contractSchema,
  deleted,
  idSchema,
  route,
} from "#src/rpc/contracts/contract-support";
import {
  configOptionsAnswerSchema,
  configOptionsParametersSchema,
  configOptionsProviderNameSchema,
} from "#src/rpc/contracts/config-options";

/**
 * Which integration a connection is for.
 *
 * A plain identifier rather than a closed list: the set of integrations is
 * whatever a host passed to `createWfGraphApp`, so the server refuses a type its
 * assembled catalog does not hold and says which types it does. A literal list
 * here could only be a second, staler copy of that answer.
 */
const integrationTypeSchema = NonEmptyTrimmedString;

const integrationConfigSchema = Schema.Record(
  Schema.String,
  Schema.UndefinedOr(Schema.String)
).check(
  Schema.makeFilter(hasOnlySafeRecordKeys, {
    expected: "integration config keys not reserved by JavaScript objects",
  })
);

const manualIntegrationConfigSchema = integrationConfigSchema.check(
  Schema.makeFilter((config) => !(OAUTH_GRANT_CONFIG_KEY in config), {
    expected: "an integration config without the reserved OAuth grant key",
  })
);

const integrationFields = {
  id: idSchema,
  name: Schema.String,
  type: integrationTypeSchema,
  isManaged: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  configuredKeys: Schema.Array(Schema.String),
  /**
   * The stored values a config field named with `connectionDefaultKey`, keyed by
   * that key, for the editor to draw as the field's placeholder. Only the values
   * some field asked for, and never a secret: the server decides both.
   */
  connectionDefaults: Schema.Record(Schema.String, Schema.String).check(
    Schema.makeFilter(hasOnlySafeRecordKeys, {
      expected: "connection default keys not reserved by JavaScript objects",
    })
  ),
  oauth: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["connected", "reauthorization_required"]),
      connectedAt: isoTimestampString(),
      accountLabel: Schema.optionalKey(Schema.String),
      credentialKeys: Schema.Array(NonEmptyTrimmedString),
      /**
       * How much access the provider granted, in its own words, for the
       * connection dialog to show. Absent for a provider that never says, and
       * for a grant issued before this connection last authorized.
       */
      grantedAccessLabel: Schema.optionalKey(NonEmptyTrimmedString),
    })
  ),
};

const integrationSchema = Schema.Struct(integrationFields);

const integrationWithConfigSchema = Schema.Struct({
  ...integrationFields,
  config: integrationConfigSchema,
});

const integrationTestResultSchema = Schema.Struct({
  status: Schema.Literals(["success", "error"]),
  message: Schema.String,
});

const integrationWithConfig = contractSchema(integrationWithConfigSchema);
const integrationTestResult = contractSchema(integrationTestResultSchema);

export const integrationContract = {
  getAll: route("GET", "/integrations", WfGraphOperations.integrationGetAll)
    .input(
      contractSchema(
        Schema.Struct({
          type: Schema.optionalKey(integrationTypeSchema),
        })
      )
    )
    .output(contractSchema(listOf(integrationSchema))),
  get: route(
    "GET",
    "/integrations/{integrationId}",
    WfGraphOperations.integrationGet
  )
    .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
    .output(integrationWithConfig),
  create: route("POST", "/integrations", WfGraphOperations.integrationCreate)
    .input(
      contractSchema(
        Schema.Struct({
          name: Schema.String,
          type: integrationTypeSchema,
          config: manualIntegrationConfigSchema,
        })
      )
    )
    .output(contractSchema(integrationSchema)),
  update: route(
    "PUT",
    "/integrations/{integrationId}",
    WfGraphOperations.integrationUpdate
  )
    .input(
      contractSchema(
        Schema.Struct({
          integrationId: idSchema,
          name: Schema.optionalKey(Schema.String),
          config: Schema.optionalKey(manualIntegrationConfigSchema),
        })
      )
    )
    .output(integrationWithConfig),
  delete: route(
    "DELETE",
    "/integrations/{integrationId}",
    WfGraphOperations.integrationDelete
  )
    .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
    .output(deleted),
  disconnectOAuth: route(
    "DELETE",
    "/integrations/{integrationId}/oauth",
    WfGraphOperations.integrationDisconnectOAuth
  )
    .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
    .output(
      contractSchema(
        Schema.Struct({
          success: Schema.Literal(true),
          /**
           * Whether the connection itself is gone. A grant that supplied the
           * whole connection leaves nothing behind, so disconnecting removes
           * the row rather than offering a connection holding no credential.
           */
          removed: Schema.Boolean,
        })
      )
    ),
  testConnection: route(
    "POST",
    "/integrations/{integrationId}/test",
    WfGraphOperations.integrationTestConnection
  )
    .input(
      contractSchema(
        Schema.Struct({
          integrationId: idSchema,
          config: Schema.optionalKey(manualIntegrationConfigSchema),
        })
      )
    )
    .output(integrationTestResult),
  configOptions: route(
    "POST",
    "/integrations/{integrationId}/config-options",
    WfGraphOperations.integrationConfigOptions
  )
    .input(
      contractSchema(
        Schema.Struct({
          integrationId: idSchema,
          provider: configOptionsProviderNameSchema(),
          parameters: Schema.optionalKey(configOptionsParametersSchema()),
        })
      )
    )
    .output(contractSchema(configOptionsAnswerSchema())),
  testCredentials: route(
    "POST",
    "/integrations/test",
    WfGraphOperations.integrationTestCredentials
  )
    .input(
      contractSchema(
        Schema.Struct({
          type: integrationTypeSchema,
          config: integrationConfigSchema,
        })
      )
    )
    .output(integrationTestResult),
};
