import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeWorkflowDraft, type AgentDocument } from "#src/document";

const initialDocument: AgentDocument = {
  nodes: [
    {
      id: "lifecycle",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle", config: {} },
    },
  ],
  edges: [],
};

describe("makeWorkflowDraft", () => {
  it.effect(
    "keeps the exact document produced by each successful revision",
    () =>
      Effect.gen(function* () {
        const draft = yield* makeWorkflowDraft({
          document: initialDocument,
          catalog: { actions: [], events: [], integrations: [] },
          integrations: [],
          validateDraft: () => ({
            draftValid: true,
            structuralIssues: [],
            publishBlockers: [],
            warnings: [],
          }),
        });
        const firstNode = {
          id: "first",
          type: "action" as const,
          position: { x: 0, y: 0 },
          data: { label: "First", type: "action" as const, config: {} },
        };
        const secondNode = {
          id: "second",
          type: "action" as const,
          position: { x: 0, y: 0 },
          data: { label: "Second", type: "action" as const, config: {} },
        };

        yield* draft.update((current) => ({
          ...current,
          nodes: [...current.nodes, firstNode],
        }));
        yield* draft.update((current) => ({
          ...current,
          nodes: [...current.nodes, secondNode],
        }));

        expect(yield* draft.revision(1)).toEqual({
          nodes: [...initialDocument.nodes, firstNode],
          edges: [],
        });
        expect(yield* draft.revision(2)).toEqual({
          nodes: [...initialDocument.nodes, firstNode, secondNode],
          edges: [],
        });
      })
  );
});
