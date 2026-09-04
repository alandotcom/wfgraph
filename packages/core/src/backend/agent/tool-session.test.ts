import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makeAgentToolSession } from "#src/backend/agent/tool-session";

describe("makeAgentToolSession", () => {
  it.effect("owns the monotonic revision linked to each successful write", () =>
    Effect.gen(function* () {
      const session = yield* makeAgentToolSession({
        document: { nodes: [], edges: [] },
        catalog: { actions: [], events: [], integrations: [] },
        integrations: [],
        validateDraft: () => ({
          draftValid: true,
          structuralIssues: [],
          publishBlockers: [],
          warnings: [],
        }),
      });
      yield* session.draft.update(() => ({
        nodes: [
          {
            id: "entry",
            type: "lifecycle",
            position: { x: 0, y: 0 },
            data: { label: "Lifecycle", type: "lifecycle", config: {} },
          },
        ],
        edges: [],
      }));

      const revision = yield* session.recordGraphRevision();
      expect(revision).toEqual({
        revision: 1,
        document: {
          nodes: [
            {
              id: "entry",
              type: "lifecycle",
              position: { x: 0, y: 0 },
              data: { label: "Lifecycle", type: "lifecycle", config: {} },
            },
          ],
          edges: [],
        },
      });
    })
  );
});
