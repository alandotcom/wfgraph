import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineAction } from "#src/backend/extensions/define-action";
import type {
  ActionConfigOptionsProvider,
  ConfigOptionsAnswer,
} from "#src/backend/extensions/config-options";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { makeExtensionsLayer } from "#src/backend/lib/effect/extensions";
import {
  InternalFailure,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { postActionConfigOptions } from "#src/backend/services/actions/config-options";

function actionWith(
  configOptions: Record<string, ActionConfigOptionsProvider>
) {
  return defineAction({
    id: "host/template-email",
    label: "Template Email",
    description: "Builds an email from an application template",
    input: Schema.Struct({
      templateId: Schema.optionalKey(Schema.String),
      variables: Schema.optionalKey(Schema.String),
    }),
    configOptions,
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
    handler: () => undefined,
  });
}

function optionsProvider(
  answer: ConfigOptionsAnswer,
  seen?: (parameters: Readonly<Record<string, string>>) => void
): ActionConfigOptionsProvider {
  return {
    answers: "options",
    load: async () => async (request) => {
      seen?.(request.parameters);
      return answer;
    },
  };
}

function effectFor(
  configOptions: Record<string, ActionConfigOptionsProvider>,
  provider: string,
  parameters: Record<string, string> = {}
) {
  return postActionConfigOptions(
    "host/template-email",
    provider,
    parameters
  ).pipe(
    Effect.provide(
      makeExtensionsLayer(
        assembleExtensions({ actions: [actionWith(configOptions)] })
      )
    )
  );
}

function run(
  configOptions: Record<string, ActionConfigOptionsProvider>,
  provider: string,
  parameters: Record<string, string> = {}
) {
  return Effect.runPromise(effectFor(configOptions, provider, parameters));
}

describe("host action config options", () => {
  it("hands only declared sibling parameters to application code", async () => {
    let parameters: Readonly<Record<string, string>> | undefined;

    const answer = await run(
      {
        templates: optionsProvider(
          {
            status: "options",
            options: [{ value: "welcome", label: "Welcome" }],
          },
          (seen) => {
            parameters = seen;
          }
        ),
      },
      "templates",
      { templateId: "welcome", smuggled: "secret" }
    );

    expect(answer).toEqual({
      status: "options",
      options: [{ value: "welcome", label: "Welcome" }],
    });
    expect(parameters).toEqual({ templateId: "welcome" });
  });

  it("refuses a retained loader after its field reference is removed", async () => {
    const plainAction = defineAction({
      id: "host/template-email",
      label: "Template Email",
      description: "Builds an email from an application template",
      input: Schema.Struct({ templateId: Schema.optionalKey(Schema.String) }),
      handler: () => undefined,
    });
    const assembled = assembleExtensions({ actions: [plainAction] });
    const retained = optionsProvider({ status: "options", options: [] });
    const failure = await Effect.runPromise(
      Effect.flip(
        postActionConfigOptions("host/template-email", "templates", {}).pipe(
          Effect.provide(
            makeExtensionsLayer({
              ...assembled,
              actionConfigOptionsFor: () => retained,
            })
          )
        )
      )
    );

    expect(failure).toBeInstanceOf(InvalidInput);
  });

  it("refuses a provider the action does not declare", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        postActionConfigOptions("host/template-email", "absent", {}).pipe(
          Effect.provide(
            makeExtensionsLayer(
              assembleExtensions({
                actions: [
                  actionWith({
                    templates: optionsProvider({
                      status: "options",
                      options: [],
                    }),
                  }),
                ],
              })
            )
          )
        )
      )
    );

    expect(failure).toBeInstanceOf(InvalidInput);
  });

  it("sanitizes an exception from application code", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        postActionConfigOptions("host/template-email", "templates", {}).pipe(
          Effect.provide(
            makeExtensionsLayer(
              assembleExtensions({
                actions: [
                  actionWith({
                    templates: {
                      answers: "options",
                      load: async () => async () => {
                        throw new Error("secret-bearing application error");
                      },
                    },
                  }),
                ],
              })
            )
          )
        )
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
    expect(failure).toMatchObject({
      error: "Failed to read action config options",
    });
  });

  it("removes explicitly undefined optional field properties before transport", async () => {
    const answer = await run(
      {
        templates: optionsProvider({ status: "options", options: [] }),
        variables: {
          answers: "fields",
          load: async () => async () => ({
            status: "fields",
            fields: [
              {
                key: "name",
                label: "Name",
                defaultValue: undefined,
                description: undefined,
                type: undefined,
                required: undefined,
              },
            ],
          }),
        },
      },
      "variables"
    );

    expect(answer).toEqual({
      status: "fields",
      fields: [{ key: "name", label: "Name" }],
    });
  });

  it("keeps unknown top-level properties for strict validation", async () => {
    const malformed = {
      status: "fields",
      fields: [],
      unexpected: "extra",
    };
    const failure = await Effect.runPromise(
      Effect.flip(
        effectFor(
          {
            templates: optionsProvider({ status: "options", options: [] }),
            variables: {
              answers: "fields",
              load: async () => async () =>
                // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the malformed application answer this case exercises
                malformed as ConfigOptionsAnswer,
            },
          },
          "variables"
        )
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
  });

  it("refuses a malformed answer before transport", async () => {
    const malformed = {
      status: "options",
      options: [{ value: "", label: "Blank id" }],
    };
    const failure = await Effect.runPromise(
      Effect.flip(
        effectFor(
          {
            templates: optionsProvider(
              // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the malformed application answer this case exercises
              malformed as ConfigOptionsAnswer
            ),
          },
          "templates"
        )
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
  });

  it("refuses an answer kind that contradicts the declaration", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        effectFor(
          {
            templates: optionsProvider({ status: "fields", fields: [] }),
          },
          "templates"
        )
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
  });
});
