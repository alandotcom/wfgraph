import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { fixtureCatalog } from "#src/tools/catalog-fixture";
import { agentToolsFor } from "#src/testing";
import { layerFromDraft, makeWorkflowDraft } from "#src/document";
import {
  agentToolkit,
  agentToolkitLayer,
  WRITE_TOOL_NAMES,
} from "#src/toolkit";

const tools = Object.values(agentToolkit.tools);

describe("the toolkit", () => {
  it("gives every tool a description, which is what the model chooses on", () => {
    for (const tool of tools) {
      expect(tool.description?.trim()).toBeTruthy();
    }
  });

  it("converts every tool's parameters to the JSON Schema a model reads", () => {
    for (const tool of tools) {
      const schema = Tool.getJsonSchema(tool);

      expect(schema, tool.name).toMatchObject({ type: "object" });
    }
  });

  it("describes every parameter, so no field reaches the model unlabelled", () => {
    for (const tool of tools) {
      const schema = Tool.getJsonSchema(tool);
      const properties: Record<string, unknown> =
        (schema as { properties?: Record<string, unknown> }).properties ?? {};

      for (const [name, property] of Object.entries(properties)) {
        expect(
          (property as { description?: string }).description?.trim(),
          `${tool.name}.${name}`
        ).toBeTruthy();
      }
    }
  });

  it("names only real tools as the ones that change the graph", () => {
    const names = new Set(tools.map((tool) => tool.name));

    for (const name of WRITE_TOOL_NAMES) {
      expect(names, name).toContain(name);
    }
    // The read tools are the rest, and none of them may claim to write.
    expect(WRITE_TOOL_NAMES.size).toBe(7);
  });

  it.effect("supplies a handler for every tool it declares, and no other", () =>
    Effect.gen(function* () {
      const subject = yield* agentToolsFor({ catalog: fixtureCatalog });

      expect(Object.keys(subject.tools).toSorted()).toEqual(
        tools.map((tool) => tool.name).toSorted()
      );
    })
  );
});

describe("the toolkit layer", () => {
  it.effect("routes a call by name, the way a model reaches a tool", () =>
    Effect.gen(function* () {
      const draft = yield* makeWorkflowDraft({
        document: { nodes: [], edges: [] },
        catalog: fixtureCatalog,
        integrations: [],
      });

      const encoded = yield* Effect.gen(function* () {
        const withHandlers = yield* agentToolkit;
        const stream = yield* withHandlers.handle("read_workflow", {});
        const results = yield* Stream.runCollect(stream);
        return results.at(-1)?.encodedResult;
      }).pipe(
        Effect.provide(
          agentToolkitLayer.pipe(Layer.provide(layerFromDraft(draft)))
        ),
        Effect.orDie
      );

      // The encoded half is what travels back to the model, so this is the
      // shape a success schema is judged on.
      expect(encoded).toEqual({ nodes: [], edges: [] });
    })
  );
});
