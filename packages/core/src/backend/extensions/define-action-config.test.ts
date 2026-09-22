import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  type DefineActionInput,
  defineAction,
} from "#src/backend/extensions/define-action";

describe("defineAction config fields", () => {
  it("auto-derives configFields from the input schema", () => {
    const action = defineAction({
      id: "custom/derive-fields",
      label: "Derive Fields",
      description: "Tests configFields derivation",
      input: z.object({
        name: z.string().meta({
          title: "Full Name",
          description: "The person's full name.",
        }),
        count: z.number().min(0).meta({ title: "Item Count" }),
        status: z
          .union([
            z.literal("active").meta({ title: "Active" }),
            z.literal("inactive").meta({ title: "Inactive" }),
          ])
          .meta({ title: "Status" }),
      }),
      handler() {
        return {};
      },
    });

    const fields = action.configFields ?? [];
    expect(fields).toHaveLength(3);

    const nameField = fields.find(
      (field) => "key" in field && field.key === "name"
    );
    expect(nameField).toBeDefined();
    expect(nameField && "type" in nameField ? nameField.type : undefined).toBe(
      "template-input"
    );
    expect(
      nameField && "label" in nameField ? nameField.label : undefined
    ).toBe("Full Name");
    expect(
      nameField && "description" in nameField
        ? nameField.description
        : undefined
    ).toBe("The person's full name.");

    const countField = fields.find(
      (field) => "key" in field && field.key === "count"
    );
    expect(
      countField && "type" in countField ? countField.type : undefined
    ).toBe("number");

    const statusField = fields.find(
      (field) => "key" in field && field.key === "status"
    );
    expect(
      statusField && "type" in statusField ? statusField.type : undefined
    ).toBe("select");
    expect(
      statusField && "options" in statusField ? statusField.options : undefined
    ).toEqual([
      { value: "active", label: "Active" },
      { value: "inactive", label: "Inactive" },
    ]);
  });

  it("infers picker fields while preserving authored presentation", () => {
    const action = defineAction({
      id: "custom/template-email",
      label: "Template Email",
      description: "Builds an email from an application template",
      input: z.object({
        templateId: z.string().optional(),
        senderId: z.string().optional(),
      }),
      configFields: [
        {
          key: "templateId",
          label: "Email template",
          placeholder: "Choose a template",
        },
        {
          key: "senderId",
          showWhen: { field: "templateId", equals: "welcome" },
        },
      ],
      options: {
        templateId: async (config) => {
          expectTypeOf(config).toEqualTypeOf<{
            readonly templateId?: string | undefined;
            readonly senderId?: string | undefined;
          }>();
          return [];
        },
        senderId: async () => [],
      },
      handler() {
        return {};
      },
    });

    expect(action.configFields).toEqual([
      expect.objectContaining({
        key: "templateId",
        label: "Email template",
        placeholder: "Choose a template",
        type: "provider-select",
        optionsSource: {
          provider: "templateId",
          parameters: ["templateId", "senderId"],
        },
      }),
      expect.objectContaining({
        key: "senderId",
        type: "provider-select",
        optionsSource: {
          provider: "senderId",
          parameters: ["templateId", "senderId"],
        },
        showWhen: { field: "templateId", equals: "welcome" },
      }),
    ]);
  });

  it("types option keys and raw draft values from the input schema", () => {
    const build = () =>
      defineAction({
        id: "custom/typed-form",
        label: "Typed Form",
        description: "Checks authored form keys",
        input: z.object({
          templateId: z.string().optional(),
          senderId: z.string().optional(),
        }),
        configFields: [
          {
            // @ts-expect-error the input schema declares no `missing` key
            key: "missing",
            type: "text",
          },
        ],
        options: {
          senderId: async (config) => {
            expectTypeOf(config.templateId).toEqualTypeOf<string | undefined>();
            // @ts-expect-error option callbacks see schema keys only
            void config.missing;
            return [];
          },
          // @ts-expect-error option keys must name an input schema field
          missing: async () => [],
        },
        handler() {
          return {};
        },
      });

    expect(build).toBeTypeOf("function");
  });

  it("preserves list conditions and types their sibling references", () => {
    const action = defineAction({
      id: "host/variants",
      label: "Variants",
      description: "Shared variant inputs",
      input: z.object({
        template: z.enum(["a", "b", "c"]),
        name: z.string().optional(),
      }),
      configFields: [
        { key: "name", showWhen: { field: "template", in: ["a", "b"] } },
      ],
      handler: () => undefined,
    });
    expect(action.configFields[0]).toMatchObject({
      key: "name",
      showWhen: { field: "template", in: ["a", "b"] },
    });

    const invalid = () =>
      defineAction({
        id: "host/invalid",
        label: "Invalid",
        description: "Type checks",
        input: z.object({ template: z.string(), name: z.string() }),
        configFields: [
          {
            key: "name",
            // @ts-expect-error list conditions must reference an input schema key
            showWhen: { field: "missing", in: ["a", "b"] },
          },
          {
            key: "name",
            // @ts-expect-error a condition must choose exactly one operator
            showWhen: { field: "template", equals: "a", in: ["a", "b"] },
          },
        ],
        handler: () => undefined,
      });
    expect(invalid).toBeTypeOf("function");
  });

  it("does not expose the old host provider wiring API", () => {
    const definition = {
      id: "custom/old-options",
      label: "Old Options",
      description: "Checks removed host provider wiring",
      input: z.object({ templateId: z.string().optional() }),
      // @ts-expect-error host actions now declare direct callbacks under `options`
      configOptions: {},
      handler: () => ({}),
    } satisfies DefineActionInput<{ templateId?: string | undefined }>;

    expect(definition).toBeDefined();
  });

  it("keeps schema titles and descriptions separate in derived configFields", () => {
    const action = defineAction({
      id: "custom/field-metadata",
      label: "Field Metadata",
      description: "Tests field metadata",
      input: z.object({
        appointmentId: z.string().meta({
          title: "Appointment ID",
          description: "The appointment to update.",
        }),
      }),
      handler() {
        return {};
      },
    });

    const fields = action.configFields ?? [];
    expect(fields).toHaveLength(1);
    expect(
      fields[0] && "label" in fields[0] ? fields[0].label : undefined
    ).toBe("Appointment ID");
    expect(
      fields[0] && "description" in fields[0]
        ? fields[0].description
        : undefined
    ).toBe("The appointment to update.");
  });

  it("produces no configFields for an empty input schema", () => {
    const action = defineAction({
      id: "custom/empty-schema",
      label: "Empty Schema",
      description: "Tests empty schema",
      input: z.object({}),
      handler() {
        return {};
      },
    });

    expect(action.configFields).toEqual([]);
  });
});
