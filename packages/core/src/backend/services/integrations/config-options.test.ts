/**
 * What a provider-backed config field is filled with, asked of one connection.
 *
 * The repository is the seam, as it is for the connection test beside it, so
 * these cases stand on a stored row and an assembled integration rather than on
 * a database.
 */

import { assert, describe, layer } from "@effect/vitest";
import { expect, it as vitestIt } from "vitest";
import { rpcContract } from "@wfgraph/shared/rpc/contracts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Effect, Layer, Schema } from "effect";
import {
  SilentAppLoggerLayer,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import { makeExtensionsLayer } from "#src/backend/lib/effect/extensions";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { postIntegrationConfigOptions } from "#src/backend/services/integrations/config-options";
import {
  InternalFailure,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import type {
  ConfigOptionsAnswer,
  ConfigOptionsProvider,
} from "#src/backend/extensions/config-options";
import type { DecryptedIntegration } from "#src/backend/services/integrations/repo";

const storedRow: DecryptedIntegration = {
  id: "int_1",
  name: "Example",
  type: "example",
  config: { EXAMPLE_KEY: "stored-secret", EXAMPLE_BLANK: "" },
  configRevision: 0,
  isManaged: false,
  refreshState: "idle",
  refreshClaimId: null,
  refreshClaimedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const repo = stubIntegrationRepo({
  findById: (id) => Effect.succeed(id === storedRow.id ? storedRow : null),
});

function integrationWith(configOptions: Record<string, ConfigOptionsProvider>) {
  return defineIntegration({
    type: "example",
    label: "Example",
    description: "test double",
    credentials: {
      EXAMPLE_KEY: { label: "Key", type: "password" },
      EXAMPLE_BLANK: { label: "Blank", type: "text" },
    },
    configOptions,
    actions: {
      send: {
        label: "Send",
        description: "Sends",
        input: Schema.Struct({
          templateId: Schema.optionalKey(Schema.String),
          variables: Schema.optionalKey(Schema.String),
        }),
        output: Schema.Struct({
          id: Schema.String.annotate({ description: "Id" }),
        }),
        configFields: [
          {
            key: "templateId",
            label: "Template",
            type: "provider-select",
            optionsSource: {
              provider: "templates",
              parameters: ["templateId"],
            },
          },
          ...(Object.hasOwn(configOptions, "variables")
            ? [
                {
                  key: "variables" as const,
                  label: "Variables",
                  type: "provider-fields" as const,
                  optionsSource: { provider: "variables" },
                },
              ]
            : []),
        ],
        handler: () => ({ id: "1" }),
      },
    },
  });
}

const optionsProvider = (
  answer: ConfigOptionsAnswer,
  seen?: (
    credentials: Record<string, string | undefined>,
    parameters: Record<string, string>
  ) => void
): ConfigOptionsProvider => ({
  answers: "options",
  load: async () => async (credentials, request) => {
    seen?.(credentials, request.parameters);
    return answer;
  },
});

const extensionsWith = (configOptions: Record<string, ConfigOptionsProvider>) =>
  makeExtensionsLayer(
    assembleExtensions({ integrations: [integrationWith(configOptions)] })
  );

const testLayer = Layer.mergeAll(
  SilentAppLoggerLayer,
  makeAppContextLayer({ apiBasePath: "/api" })
);

describe("integration config options", () => {
  layer(testLayer)((it) => {
    it.effect("hands the connection's credentials to the provider", () =>
      Effect.gen(function* () {
        let credentials: Record<string, string | undefined> | undefined;
        let parameters: Record<string, string> | undefined;
        const extensions = extensionsWith({
          templates: optionsProvider(
            {
              status: "options",
              options: [{ value: "t1", label: "Welcome" }],
            },
            (seenCredentials, seenParameters) => {
              credentials = seenCredentials;
              parameters = seenParameters;
            }
          ),
        });

        const answer = yield* postIntegrationConfigOptions(
          "int_1",
          "templates",
          { templateId: "t1" }
        ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)));

        assert.deepStrictEqual(answer, {
          status: "options",
          options: [{ value: "t1", label: "Welcome" }],
        });
        assert.strictEqual(credentials?.EXAMPLE_KEY, "stored-secret");
        assert.deepStrictEqual(parameters, { templateId: "t1" });
      })
    );

    // A provider refusing is information the builder acts on, so it arrives as
    // an answer rather than as a failed request that loses the sentence.
    it.effect("answers a refusal as a success", () =>
      Effect.gen(function* () {
        const extensions = extensionsWith({
          templates: optionsProvider({
            status: "unavailable",
            reason: "not_permitted",
            message: "This connection cannot read templates.",
          }),
        });

        const answer = yield* postIntegrationConfigOptions(
          "int_1",
          "templates",
          {}
        ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)));

        assert.deepStrictEqual(answer, {
          status: "unavailable",
          reason: "not_permitted",
          message: "This connection cannot read templates.",
        });
      })
    );

    // Every parameter lands in a request this connection's credentials pay for,
    // so the field's declaration is the allowlist rather than the request.
    it.effect("drops a parameter no field declared for this provider", () =>
      Effect.gen(function* () {
        let parameters: Record<string, string> | undefined;
        const extensions = extensionsWith({
          templates: optionsProvider(
            { status: "options", options: [] },
            (_credentials, seen) => {
              parameters = seen;
            }
          ),
        });

        yield* postIntegrationConfigOptions("int_1", "templates", {
          templateId: "t1",
          smuggled: "../../admin",
        }).pipe(Effect.provide(Layer.mergeAll(repo, extensions)));

        assert.deepStrictEqual(parameters, { templateId: "t1" });
      })
    );

    // Resolving credentials is not a read: on an expired grant it claims the
    // refresh and exchanges tokens, which a request naming an undeclared
    // provider must never be able to spend.
    it.effect(
      "refuses an undeclared provider before touching credentials",
      () =>
        Effect.gen(function* () {
          let resolved = 0;
          const countingRepo = stubIntegrationRepo({
            findById: (id) =>
              Effect.sync(() => {
                resolved += 1;
                return id === storedRow.id ? storedRow : null;
              }),
          });
          const extensions = extensionsWith({
            templates: optionsProvider({ status: "options", options: [] }),
          });

          yield* postIntegrationConfigOptions("int_1", "absent", {}).pipe(
            Effect.provide(Layer.mergeAll(countingRepo, extensions)),
            Effect.flip
          );

          // One read, for the type. The resolver would have made a second.
          assert.strictEqual(resolved, 1);
        })
    );

    it.effect("refuses a provider this build does not declare", () =>
      Effect.gen(function* () {
        const extensions = extensionsWith({
          templates: optionsProvider({ status: "options", options: [] }),
        });

        const failure = yield* postIntegrationConfigOptions(
          "int_1",
          "absent",
          {}
        ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)), Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.include(failure.error, "declares no config options provider");
      })
    );

    it.effect("keeps a provider that throws in the error channel", () =>
      Effect.gen(function* () {
        const extensions = extensionsWith({
          templates: {
            answers: "options",
            load: async () => () => {
              throw new Error("vendor said no");
            },
          },
        });

        const failure = yield* postIntegrationConfigOptions(
          "int_1",
          "templates",
          {}
        ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)), Effect.flip);

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, "vendor said no");
      })
    );

    it.effect("keeps a loader that throws in the error channel", () =>
      Effect.gen(function* () {
        const extensions = extensionsWith({
          templates: {
            answers: "options",
            load: () => Promise.reject(new Error("module missing")),
          },
        });

        const failure = yield* postIntegrationConfigOptions(
          "int_1",
          "templates",
          {}
        ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)), Effect.flip);

        assert.instanceOf(failure, InternalFailure);
        assert.strictEqual(failure.error, "module missing");
      })
    );

    // A provider answering the wrong kind is a plugin bug an operator should
    // see, not something to draw in the builder's panel.
    it.effect(
      "refuses an answer contradicting what the provider declared",
      () =>
        Effect.gen(function* () {
          const extensions = extensionsWith({
            templates: {
              answers: "options",
              load: async () => async () => ({
                status: "fields" as const,
                fields: [],
              }),
            },
          });

          const failure = yield* postIntegrationConfigOptions(
            "int_1",
            "templates",
            {}
          ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)), Effect.flip);

          assert.instanceOf(failure, InternalFailure);
          assert.include(failure.error, 'answered "fields"');
        })
    );

    it.effect("refuses a provider field with a reserved record key", () =>
      Effect.gen(function* () {
        const extensions = extensionsWith({
          templates: optionsProvider({ status: "options", options: [] }),
          variables: {
            answers: "fields",
            load: async () => async () => ({
              status: "fields",
              fields: [{ key: "constructor", label: "Unsafe" }],
            }),
          },
        });

        const failure = yield* postIntegrationConfigOptions(
          "int_1",
          "variables",
          {}
        ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)), Effect.flip);

        assert.instanceOf(failure, InternalFailure);
        assert.include(
          failure.error,
          "field key reserved by JavaScript objects"
        );
      })
    );

    it.effect("refuses a connection this server does not hold", () =>
      Effect.gen(function* () {
        const extensions = extensionsWith({
          templates: optionsProvider({ status: "options", options: [] }),
        });

        const failure = yield* postIntegrationConfigOptions(
          "missing",
          "templates",
          {}
        ).pipe(Effect.provide(Layer.mergeAll(repo, extensions)), Effect.flip);

        assert.isDefined(failure);
      })
    );
  });
});

/**
 * Core's plugin-facing `ConfigOptionsAnswer` and the contract that carries it
 * are written separately, so nothing but this holds them in step. A field one
 * side gained and the other did not would otherwise reach a plugin author as a
 * type they can fill in and a wire that silently drops.
 */
describe("the answer an integration may return", () => {
  // The contract carries Standard Schemas, which is what oRPC validates against,
  // so this runs the same check the wire runs.
  const outputSchema = rpcContract.integration.configOptions["~orpc"]
    .outputSchemas?.[0] as unknown as StandardSchemaV1 | undefined;
  if (!outputSchema) {
    throw new Error("The contract must declare an output schema");
  }
  const decode = (value: unknown) => outputSchema["~standard"].validate(value);

  vitestIt.each([
    {
      name: "options",
      answer: {
        status: "options",
        options: [{ value: "tpl_1", label: "Welcome" }],
      },
    },
    {
      name: "fields",
      answer: {
        status: "fields",
        fields: [
          {
            key: "FIRST_NAME",
            label: "First name",
            defaultValue: "Ada",
            description: "Who it is for",
            type: "string",
          },
        ],
      },
    },
    {
      name: "unavailable",
      answer: {
        status: "unavailable",
        reason: "not_permitted",
        message: "This connection cannot read templates.",
      },
    },
  ])("crosses the wire as written: $name", ({ answer }) => {
    const typed: ConfigOptionsAnswer = answer as ConfigOptionsAnswer;
    const result = decode(typed);

    expect("issues" in result ? result.issues : undefined).toBeUndefined();
  });

  vitestIt("refuses a field one side gained and the other did not", () => {
    // The teeth: the contract decodes with `rejectUnknownKeys`, so a member core
    // grew without the wire growing it fails here rather than being dropped in
    // silence on the way to the browser.
    const result = decode({
      status: "options",
      options: [{ value: "tpl_1", label: "Welcome", icon: "envelope" }],
    });

    expect("issues" in result ? result.issues : undefined).toBeDefined();
  });

  vitestIt("refuses a provider field with a reserved record key", () => {
    const result = decode({
      status: "fields",
      fields: [{ key: "__proto__", label: "Unsafe" }],
    });

    expect("issues" in result ? result.issues : undefined).toBeDefined();
  });
});
