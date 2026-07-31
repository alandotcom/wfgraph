/**
 * The fixtures here are Zod, deliberately, and Zod is a devDependency of this
 * package for no other reason. `createAction` takes any Standard Schema, and
 * writing these against the library the repo itself uses would leave that claim
 * untested: a schema built by Effect would only prove it works with the shape
 * Effect produces. `standard-schema-compat.test.ts` makes the same point with
 * arktype from the other side.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAction } from "./action-registry";

describe("createAction", () => {
  it("validates payload with schema and executes with typed payload", async () => {
    const action = createAction({
      id: "custom/echo",
      label: "Echo",
      description: "Echoes text input",
      schema: z.object({
        text: z.string().trim().min(1),
      }),
      execute({ payload }) {
        return {
          success: true,
          data: {
            text: payload.text,
          },
        };
      },
    });

    const result = await action.execute({
      payload: { text: " hello " },
      context: {
        nodeId: "node_1",
        nodeName: "Echo",
        nodeType: "custom/echo",
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        text: "hello",
      },
    });
  });

  it("returns a failure result when payload does not match schema", async () => {
    const action = createAction({
      id: "custom/requires-text",
      label: "Requires Text",
      description: "Requires a text value",
      schema: z.object({
        text: z.string().trim().min(1),
      }),
      execute() {
        return { success: true };
      },
    });

    const result = await action.execute({
      payload: { text: "" },
      context: {
        nodeId: "node_1",
        nodeName: "Requires Text",
        nodeType: "custom/requires-text",
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(
        typeof result.error === "object" &&
          result.error !== null &&
          "message" in result.error &&
          typeof result.error.message === "string" &&
          result.error.message.includes("received an invalid payload")
      ).toBe(true);
    }
  });

  it("returns a failure result when execute throws", async () => {
    const action = createAction({
      id: "custom/throws",
      label: "Throws",
      description: "Always throws",
      schema: z.object({
        text: z.string(),
      }),
      execute() {
        throw new Error("boom");
      },
    });

    const result = await action.execute({
      payload: { text: "hello" },
      context: {
        nodeId: "node_1",
        nodeName: "Throws",
        nodeType: "custom/throws",
      },
    });

    expect(result).toEqual({
      success: false,
      error: { message: "boom" },
    });
  });

  it("auto-derives configFields from schema", () => {
    const action = createAction({
      id: "custom/derive-fields",
      label: "Derive Fields",
      description: "Tests configFields derivation",
      schema: z.object({
        name: z.string().describe("Full Name"),
        count: z.number().min(0).describe("Item Count"),
        status: z.enum(["active", "inactive"]).describe("Status"),
      }),
      execute() {
        return { success: true };
      },
    });

    const fields = action.configFields ?? [];
    expect(fields).toHaveLength(3);

    const nameField = fields.find((f) => "key" in f && f.key === "name");
    expect(nameField).toBeDefined();
    expect(nameField && "type" in nameField ? nameField.type : undefined).toBe(
      "template-input"
    );
    expect(
      nameField && "label" in nameField ? nameField.label : undefined
    ).toBe("Full Name");

    const countField = fields.find((f) => "key" in f && f.key === "count");
    expect(
      countField && "type" in countField ? countField.type : undefined
    ).toBe("number");

    const statusField = fields.find((f) => "key" in f && f.key === "status");
    expect(
      statusField && "type" in statusField ? statusField.type : undefined
    ).toBe("select");
    expect(
      statusField && "options" in statusField ? statusField.options : undefined
    ).toEqual([
      { value: "active", label: "active" },
      { value: "inactive", label: "inactive" },
    ]);
  });

  it("uses .describe() labels for derived configFields", () => {
    const action = createAction({
      id: "custom/describe-labels",
      label: "Describe Labels",
      description: "Tests describe labels",
      schema: z.object({
        appointmentId: z.string().describe("Appointment ID"),
      }),
      execute() {
        return { success: true };
      },
    });

    const fields = action.configFields ?? [];
    expect(fields).toHaveLength(1);
    expect(
      fields[0] && "label" in fields[0] ? fields[0].label : undefined
    ).toBe("Appointment ID");
  });

  it("produces no configFields for empty schema", () => {
    const action = createAction({
      id: "custom/empty-schema",
      label: "Empty Schema",
      description: "Tests empty schema",
      schema: z.object({}),
      execute() {
        return { success: true };
      },
    });

    expect(action.configFields).toEqual([]);
  });
});

describe("createAction with outputSchema", () => {
  it("auto-derives outputFields from Zod outputSchema", () => {
    const action = createAction({
      id: "custom/typed-output",
      label: "Typed Output",
      description: "Action with typed output",
      schema: z.object({ id: z.string() }),
      outputSchema: z.object({
        name: z.string(),
        age: z.number(),
        active: z.boolean(),
      }),
      execute() {
        return {
          success: true,
          data: { name: "Alice", age: 30, active: true },
        };
      },
    });

    expect(action.outputFields).toBeDefined();
    const fields = action.outputFields ?? [];
    expect(fields.length).toBe(3);

    const nameField = fields.find((f) => f.path === "name");
    expect(nameField).toBeDefined();
    expect(nameField?.type).toBe("string");

    const ageField = fields.find((f) => f.path === "age");
    expect(ageField).toBeDefined();
    expect(ageField?.type).toBe("number");

    const activeField = fields.find((f) => f.path === "active");
    expect(activeField).toBeDefined();
    expect(activeField?.type).toBe("boolean");
  });

  // The default is what an author who named no category gets, and it is the group
  // heading the action selector lists them under.
  it("defaults an action with no category to Custom", () => {
    const action = createAction({
      id: "custom/uncategorized",
      label: "Uncategorized",
      description: "Names no category",
      schema: z.object({ value: z.string() }),
      execute() {
        return { success: true };
      },
    });

    expect(action.category).toBe("Custom");
  });
});
