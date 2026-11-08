/**
 * One request-scoped workflow draft with its executable authoring tools.
 *
 * The runner receives this session instead of constructing tool state itself.
 * The session keeps the draft and handlers under one owner and one lifetime.
 */

import { Effect, Layer } from "effect";
import type { Toolkit } from "effect/ai";
import {
  layerFromDraft,
  makeWorkflowDraft,
  type WorkflowDraftInput,
  type WorkflowDraftService,
} from "@wfgraph/agent/document";
import { agentToolkit, agentToolkitLayer } from "@wfgraph/agent/toolkit";
import { serializeWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { validateGraphSaveShape } from "#src/backend/services/workflows/graph-save";

export type AgentToolSession = {
  /** The mutable draft shared by every tool call in this turn. */
  readonly draft: WorkflowDraftService;
  /** The complete tool set bound to the session draft. */
  readonly toolkit: Toolkit.WithHandler<Toolkit.Tools<typeof agentToolkit>>;
};

/** Creates the isolated draft and handlers used for one agent turn. */
export const makeAgentToolSession = Effect.fn("makeAgentToolSession")(
  function* (input: Omit<WorkflowDraftInput, "validateUpdate">) {
    const draft = yield* makeWorkflowDraft({
      ...input,
      validateUpdate: (document) => {
        const validation = validateGraphSaveShape(
          serializeWorkflowGraphData(document)
        );
        return validation.valid ? null : validation.error;
      },
    });
    const toolkit = yield* Effect.provide(
      agentToolkit,
      agentToolkitLayer.pipe(Layer.provide(layerFromDraft(draft)))
    );

    return { draft, toolkit } satisfies AgentToolSession;
  }
);
