/**
 * A provider-backed field is wired to a provider that can answer it.
 *
 * Every case here is a mistake nothing else catches until a builder opens the
 * panel and meets a control with no data behind it, so `checkIntegration` refuses
 * the definition and the author's own suite is where it lands.
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  checkIntegration,
  defineIntegration,
} from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineAction } from "#src/backend/extensions/define-action";
import type { ActionConfigFieldFor } from "#src/backend/extensions/steps/define-step";
import type {
  ActionConfigOptionsProvider,
  ConfigOptionsProvider,
} from "#src/backend/extensions/config-options";
import { RESERVED_RECORD_KEYS } from "@wfgraph/shared/types/record-key";

const templates: ConfigOptionsProvider = {
  answers: "options",
  load: async () => async () => ({ status: "options", options: [] }),
};

const templateVariables: ConfigOptionsProvider = {
  answers: "fields",
  load: async () => async () => ({ status: "fields", fields: [] }),
};

/** The one action every case below declares, so its config keys are fixed. */
type ExampleInput = {
  readonly templateId?: string | undefined;
  readonly variables?: string | undefined;
};

// This harness declares no credentials, so a field cannot name a Connection
// default key.
function integrationWith(input: {
  configFields: readonly ActionConfigFieldFor<ExampleInput>[];
  configOptions?: Record<string, ConfigOptionsProvider> | undefined;
}) {
  return defineIntegration({
    type: "example",
    label: "Example",
    description: "Test integration",
    credentials: {},
    configOptions: input.configOptions,
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
        configFields: input.configFields,
        handler: () => ({ id: "1" }),
      },
    },
  });
}

function unsafeFieldKey(key: string): ActionConfigFieldFor<ExampleInput> {
  return {
    key,
    label: "Unsafe",
    type: "text",
  } as unknown as ActionConfigFieldFor<ExampleInput>;
}

function unsafeParameterKey(key: string): (keyof ExampleInput)[] {
  return [key] as (keyof ExampleInput)[];
}

describe("provider-backed config fields", () => {
  it("accepts a field wired to a provider that answers its kind", () => {
    expect(() =>
      checkIntegration(
        integrationWith({
          configOptions: { templates, "template-variables": templateVariables },
          configFields: [
            {
              key: "templateId",
              label: "Template",
              type: "provider-select",
              optionsSource: { provider: "templates" },
            },
            {
              key: "variables",
              label: "Variables",
              type: "provider-fields",
              optionsSource: {
                provider: "template-variables",
                parameters: ["templateId"],
              },
            },
          ],
        })
      )
    ).not.toThrow();
  });

  it("refuses a field naming a provider the integration never declared", () => {
    expect(() =>
      checkIntegration(
        integrationWith({
          configFields: [
            {
              key: "templateId",
              label: "Template",
              type: "provider-select",
              optionsSource: { provider: "templates" },
            },
          ],
        })
      )
    ).toThrow(/does not declare/u);
  });

  it.each(RESERVED_RECORD_KEYS)(
    "refuses the reserved provider key %s",
    (key) => {
      expect(() =>
        checkIntegration(
          integrationWith({
            configOptions: Object.fromEntries([[key, templates]]),
            configFields: [
              {
                key: "templateId",
                label: "Template",
                type: "provider-select",
                optionsSource: { provider: key },
              },
            ],
          })
        )
      ).toThrow(/key reserved by JavaScript objects/u);
    }
  );

  it.each(RESERVED_RECORD_KEYS)(
    "refuses the reserved config field key %s",
    (key) => {
      expect(() =>
        checkIntegration(
          integrationWith({
            configFields: [unsafeFieldKey(key)],
          })
        )
      ).toThrow(/config field with a key reserved/u);
    }
  );

  it.each(RESERVED_RECORD_KEYS)(
    "refuses the reserved provider parameter %s",
    (key) => {
      expect(() =>
        checkIntegration(
          integrationWith({
            configOptions: { templates },
            configFields: [
              {
                key: "templateId",
                label: "Template",
                type: "provider-select",
                optionsSource: {
                  provider: "templates",
                  parameters: unsafeParameterKey(key),
                },
              },
            ],
          })
        )
      ).toThrow(/key reserved by JavaScript objects/u);
    }
  );

  it("refuses a picker wired to a provider that answers fields", () => {
    expect(() =>
      checkIntegration(
        integrationWith({
          configOptions: { templates: templateVariables },
          configFields: [
            {
              key: "templateId",
              label: "Template",
              type: "provider-select",
              optionsSource: { provider: "templates" },
            },
          ],
        })
      )
    ).toThrow(/needs a provider answering "options"/u);
  });

  it("refuses a parameter that is not a config field of the same action", () => {
    expect(() =>
      checkIntegration(
        integrationWith({
          configOptions: { templates },
          configFields: [
            {
              key: "templateId",
              label: "Template",
              type: "provider-select",
              optionsSource: {
                provider: "templates",
                parameters: unsafeParameterKey("nope"),
              },
            },
          ],
        })
      )
    ).toThrow(/is not a config field of this action/u);
  });

  it("refuses provider-fields with nothing saying what to draw", () => {
    expect(() =>
      checkIntegration(
        integrationWith({
          configFields: [
            { key: "variables", label: "Variables", type: "provider-fields" },
          ],
        })
      )
    ).toThrow(/no optionsSource/u);
  });

  it("refuses provider-select with nothing saying what to draw", () => {
    expect(() =>
      checkIntegration(
        integrationWith({
          configFields: [
            { key: "templateId", label: "Template", type: "provider-select" },
          ],
        })
      )
    ).toThrow(/no optionsSource/u);
  });

  it("refuses an optionsSource on a field type that draws no provider data", () => {
    expect(() =>
      checkIntegration(
        integrationWith({
          configOptions: { templates },
          configFields: [
            {
              key: "templateId",
              label: "Template",
              type: "text",
              optionsSource: { provider: "templates" },
            },
          ],
        })
      )
    ).toThrow(/draws no provider data/u);
  });

  it("hands the declared provider back, keyed by integration and name", () => {
    const set = assembleExtensions({
      integrations: [
        integrationWith({
          configOptions: { templates },
          configFields: [
            {
              key: "templateId",
              label: "Template",
              type: "provider-select",
              optionsSource: { provider: "templates" },
            },
          ],
        }),
      ],
    });

    expect(set.configOptionsFor("example", "templates")).toBe(templates);
    expect(set.configOptionsFor("example", "absent")).toBeUndefined();
    expect(set.configOptionsFor("other", "templates")).toBeUndefined();
    // The provider stays server-side: the catalog carries the field's own
    // `optionsSource` and nothing that could answer it.
    expect(JSON.stringify(set.catalog)).not.toContain("answers");
  });

  it("hands back a host action's provider without putting it in the catalog", () => {
    const hostTemplates: ActionConfigOptionsProvider = {
      answers: "options",
      load: async () => async () => ({ status: "options", options: [] }),
    };
    const hostAction = defineAction({
      id: "host/thing",
      label: "Thing",
      description: "A host action",
      input: Schema.Struct({ templateId: Schema.optionalKey(Schema.String) }),
      output: Schema.Struct({
        ok: Schema.Boolean.annotate({ description: "Ok" }),
      }),
      configOptions: { templates: hostTemplates },
      configFields: [
        {
          key: "templateId",
          label: "Template",
          type: "provider-select",
          optionsSource: { provider: "templates" },
        },
      ],
      handler: () => ({ ok: true }),
    });

    const set = assembleExtensions({ actions: [hostAction] });

    expect(set.actionConfigOptionsFor("host/thing", "templates")).toBe(
      hostTemplates
    );
    expect(set.actionConfigOptionsFor("host/thing", "absent")).toBeUndefined();
    expect(JSON.stringify(set.catalog)).not.toContain("answers");

    const withoutAction = assembleExtensions({ actions: [] });
    expect(
      withoutAction.actionConfigOptionsFor("host/thing", "templates")
    ).toBeUndefined();
  });

  it("refuses a host provider after its last field reference is removed", () => {
    const hostAction = defineAction({
      id: "host/thing",
      label: "Thing",
      description: "A host action",
      input: Schema.Struct({ templateId: Schema.optionalKey(Schema.String) }),
      configOptions: {
        templates: {
          answers: "options",
          load: async () => async () => ({ status: "options", options: [] }),
        },
      },
      handler: () => undefined,
    });

    expect(() => assembleExtensions({ actions: [hostAction] })).toThrow(
      /no config field references/u
    );
  });

  it("refuses more provider parameters than one request can carry", () => {
    const hostAction = defineAction({
      id: "host/thing",
      label: "Thing",
      description: "A host action",
      input: Schema.Struct({
        variables: Schema.optionalKey(Schema.String),
        p1: Schema.optionalKey(Schema.String),
        p2: Schema.optionalKey(Schema.String),
        p3: Schema.optionalKey(Schema.String),
        p4: Schema.optionalKey(Schema.String),
        p5: Schema.optionalKey(Schema.String),
        p6: Schema.optionalKey(Schema.String),
        p7: Schema.optionalKey(Schema.String),
        p8: Schema.optionalKey(Schema.String),
        p9: Schema.optionalKey(Schema.String),
      }),
      configOptions: {
        variables: {
          answers: "fields",
          load: async () => async () => ({ status: "fields", fields: [] }),
        },
      },
      configFields: [
        {
          key: "variables",
          type: "provider-fields",
          optionsSource: {
            provider: "variables",
            parameters: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"],
          },
        },
      ],
      handler: () => undefined,
    });

    expect(() => assembleExtensions({ actions: [hostAction] })).toThrow(
      /more than 8 distinct provider parameters/u
    );
  });

  it("refuses a host field naming a provider its action does not declare", () => {
    const hostAction = defineAction({
      id: "host/thing",
      label: "Thing",
      description: "A host action",
      input: Schema.Struct({ templateId: Schema.optionalKey(Schema.String) }),
      configFields: [
        {
          key: "templateId",
          type: "provider-select",
          optionsSource: { provider: "templates" },
        },
      ],
      handler: () => undefined,
    });

    expect(() => assembleExtensions({ actions: [hostAction] })).toThrow(
      /host action "host\/thing" does not declare/u
    );
  });
});
