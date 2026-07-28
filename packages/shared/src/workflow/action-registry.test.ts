import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAction,
  getRuntimeAction,
  listRuntimeActions,
  registerRuntimeAction,
  unregisterRuntimeAction,
} from "./action-registry";

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

  it("merges manual outputFields on top of auto-derived", () => {
    const action = createAction({
      id: "custom/merged-output",
      label: "Merged Output",
      description: "Action with merged output fields",
      schema: z.object({ id: z.string() }),
      outputSchema: z.object({
        name: z.string(),
        score: z.number(),
      }),
      outputFields: [
        { path: "name", description: "Full legal name" },
        { path: "extra", description: "Extra field not in schema" },
      ],
      execute() {
        return { success: true, data: { name: "Bob", score: 99 } };
      },
    });

    const fields = action.outputFields ?? [];
    expect(fields.length).toBe(3);

    const nameField = fields.find((f) => f.path === "name");
    expect(nameField?.description).toBe("Full legal name");

    const scoreField = fields.find((f) => f.path === "score");
    expect(scoreField).toBeDefined();

    const extraField = fields.find((f) => f.path === "extra");
    expect(extraField?.description).toBe("Extra field not in schema");
  });

  it("preserves existing behavior without outputSchema", () => {
    const action = createAction({
      id: "custom/no-output-schema",
      label: "No Output Schema",
      description: "Action without output schema",
      schema: z.object({ text: z.string() }),
      outputFields: [{ path: "result", description: "Manual result field" }],
      execute() {
        return { success: true, data: { result: "ok" } };
      },
    });

    expect(action.outputFields).toEqual([
      { path: "result", description: "Manual result field" },
    ]);
  });
});

describe("runtime action registry", () => {
  it("registers metadata and allows unregistering custom actions", () => {
    const actionId = "custom/runtime-registry";
    const action = createAction({
      id: actionId,
      label: "Registry Action",
      description: "Registry action description",
      schema: z.object({
        value: z.string(),
      }),
      execute() {
        return { success: true };
      },
    });

    registerRuntimeAction(action);

    const runtimeAction = getRuntimeAction(actionId);
    expect(runtimeAction).toBeDefined();
    expect(runtimeAction?.category).toBe("Custom");

    const metadata = listRuntimeActions().find(
      (value) => value.id === actionId
    );
    expect(metadata).toBeDefined();
    expect(metadata?.label).toBe("Registry Action");

    unregisterRuntimeAction(actionId);
    expect(getRuntimeAction(actionId)).toBeUndefined();
  });
});
