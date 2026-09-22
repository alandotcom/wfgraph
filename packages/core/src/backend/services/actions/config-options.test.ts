import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineAction } from "#src/backend/extensions/define-action";
import type {
  ActionOptions,
  ActionOptionsResult,
} from "#src/backend/extensions/config-options";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { makeExtensionsLayer } from "#src/backend/lib/effect/extensions";
import {
  InternalFailure,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { postActionConfigOptions } from "#src/backend/services/actions/config-options";

type TemplateEmailInput = {
  readonly templateId?: string | undefined;
  readonly senderId?: string | undefined;
  readonly subject?: string | undefined;
};

function actionWith(options: ActionOptions<TemplateEmailInput>) {
  return defineAction({
    id: "host/template-email",
    label: "Template Email",
    description: "Builds an email from an application template",
    input: Schema.Struct({
      templateId: Schema.optionalKey(Schema.String),
      senderId: Schema.optionalKey(Schema.String),
      subject: Schema.optionalKey(Schema.String),
    }),
    options,
    handler: () => undefined,
  });
}

function effectFor(
  options: ActionOptions<TemplateEmailInput>,
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
        assembleExtensions({ actions: [actionWith(options)] })
      )
    )
  );
}

function run(
  options: ActionOptions<TemplateEmailInput>,
  provider: string,
  parameters: Record<string, string> = {}
) {
  return Effect.runPromise(effectFor(options, provider, parameters));
}

describe("host action config options", () => {
  it("hands all declared raw draft strings directly to application code", async () => {
    let config: Readonly<Record<string, string | undefined>> | undefined;

    const answer = await run(
      {
        templateId: async (draft) => {
          config = draft;
          return [{ value: "welcome", label: "Welcome" }];
        },
      },
      "templateId",
      {
        templateId: "  welcome  ",
        senderId: "{{@n1:Lead.senderId}}",
        subject: "   ",
        smuggled: "secret",
      }
    );

    expect(answer).toEqual({
      status: "options",
      options: [{ value: "welcome", label: "Welcome" }],
    });
    expect(config).toEqual({ templateId: "  welcome  " });
  });

  it("accepts choices returned directly by a synchronous callback", async () => {
    const answer = await run(
      { templateId: () => [{ value: "welcome", label: "Welcome" }] },
      "templateId"
    );

    expect(answer).toEqual({
      status: "options",
      options: [{ value: "welcome", label: "Welcome" }],
    });
  });

  it("preserves an unavailable answer", async () => {
    const answer = await run(
      {
        templateId: async () => ({
          status: "unavailable",
          reason: "unreachable",
          message: "Templates are temporarily unavailable.",
        }),
      },
      "templateId"
    );

    expect(answer).toEqual({
      status: "unavailable",
      reason: "unreachable",
      message: "Templates are temporarily unavailable.",
    });
  });

  it("refuses a retained callback after its inferred field is removed", async () => {
    const plainAction = defineAction({
      id: "host/template-email",
      label: "Template Email",
      description: "Builds an email from an application template",
      input: Schema.Struct({ templateId: Schema.optionalKey(Schema.String) }),
      handler: () => undefined,
    });
    const assembled = assembleExtensions({ actions: [plainAction] });
    const retained = async () => [];
    const failure = await Effect.runPromise(
      Effect.flip(
        postActionConfigOptions("host/template-email", "templateId", {}).pipe(
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

  it("refuses an option key the action does not declare", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        postActionConfigOptions("host/template-email", "absent", {}).pipe(
          Effect.provide(
            makeExtensionsLayer(
              assembleExtensions({
                actions: [actionWith({ templateId: async () => [] })],
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
        postActionConfigOptions("host/template-email", "templateId", {}).pipe(
          Effect.provide(
            makeExtensionsLayer(
              assembleExtensions({
                actions: [
                  actionWith({
                    templateId: async () => {
                      throw new Error("secret-bearing application error");
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

  it("refuses a malformed answer before transport", async () => {
    const malformed = [{ value: "", label: "Blank id" }];
    const failure = await Effect.runPromise(
      Effect.flip(
        effectFor(
          {
            templateId: async () =>
              // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the malformed application answer this case exercises
              malformed as ActionOptionsResult,
          },
          "templateId"
        )
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
  });
});
