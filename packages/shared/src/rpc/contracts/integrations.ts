import { Schema } from "effect";
import { WfGraphOperations } from "#src/authorization/operations";
import { OAUTH_GRANT_CONFIG_KEY } from "#src/types/integration";
import { hasOnlySafeRecordKeys, isSafeRecordKey } from "#src/types/record-key";
import { NonEmptyTrimmedString, listOf } from "#src/types/schema";
import { isoTimestampString } from "#src/types/timestamp";
import {
  contractSchema,
  deleted,
  idSchema,
  route,
} from "#src/rpc/contracts/contract-support";

/**
 * Which integration a connection is for.
 *
 * A plain identifier rather than a closed list: the set of integrations is
 * whatever a host passed to `createWfGraphApp`, so the server refuses a type its
 * assembled catalog does not hold and says which types it does. A literal list
 * here could only be a second, staler copy of that answer.
 */
const integrationTypeSchema = NonEmptyTrimmedString;

const safeNonEmptyRecordKeySchema = NonEmptyTrimmedString.check(
  Schema.makeFilter(isSafeRecordKey, {
    expected:
      "a non-empty record key that is not reserved by JavaScript objects",
  })
);

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

/**
 * What a provider-backed config field is filled with.
 *
 * Three arms, because a provider refusing is an answer rather than a failure:
 * the sentence it wrote is what a builder acts on, and an error response would
 * lose it. `not_permitted` is the one arm reconnecting can fix.
 */
const configOptionsAnswerSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("options"),
    options: Schema.Array(
      Schema.Struct({
        value: NonEmptyTrimmedString,
        label: Schema.String,
      })
    ),
  }),
  Schema.Struct({
    status: Schema.Literal("fields"),
    fields: Schema.Array(
      Schema.Struct({
        key: safeNonEmptyRecordKeySchema,
        label: Schema.String,
        defaultValue: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        type: Schema.optionalKey(Schema.Literals(["string", "number"])),
        required: Schema.optionalKey(Schema.Boolean),
      })
    ),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["not_permitted", "unreachable", "refused"]),
    message: Schema.String,
  }),
]);

/**
 * The sibling config values named by a field's `optionsSource`.
 *
 * The real allowlist is server-side: the service intersects this against what a
 * field actually declared for the provider being asked, so an undeclared key
 * never reaches the integration. This bound is only what keeps an oversized body
 * from being decoded at all.
 */
const configOptionsParametersSchema = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isMaxLength(2048))
).check(
  Schema.makeFilter(hasOnlySafeRecordKeys, {
    expected: "provider parameter keys not reserved by JavaScript objects",
  }),
  Schema.makeFilter((values) => Object.keys(values).length <= 8, {
    expected: "at most eight provider parameters",
  })
);

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
          provider: safeNonEmptyRecordKeySchema,
          parameters: Schema.optionalKey(configOptionsParametersSchema),
        })
      )
    )
    .output(contractSchema(configOptionsAnswerSchema)),
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
