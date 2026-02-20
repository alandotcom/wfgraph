import { describe, expect, it } from "bun:test";
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
      expect(result.error).toEqual({
        message: 'Action "custom/requires-text" received an invalid payload.',
      });
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
