/**
 * One request-scoped workflow draft with its executable authoring tools.
 *
 * The runner receives this session instead of constructing tool state itself.
 * The session keeps the draft and handlers under one owner and one lifetime.
 */

import { Effect, Layer, Stream } from "effect";
import type { Tool, Toolkit } from "effect/ai";
import {
  layerFromDraft,
  makeWorkflowDraft,
  type WorkflowDraftInput,
  type WorkflowDraftService,
} from "@wfgraph/agent/document";
import {
  WorkflowOperations,
  type WorkflowOperationsService,
} from "@wfgraph/agent/operations";
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
  function* (
    input: Omit<WorkflowDraftInput, "validateUpdate"> & {
      /** Runs, test runs and field choices; absent, those tools refuse. */
      readonly operations?: WorkflowOperationsService | undefined;
    }
  ) {
    const { operations, ...draftInput } = input;
    const draft = yield* makeWorkflowDraft({
      ...draftInput,
      validateUpdate: (document) => {
        const validation = validateGraphSaveShape(
          serializeWorkflowGraphData(document)
        );
        return validation.valid ? null : validation.error;
      },
    });
    const handlers = agentToolkitLayer.pipe(
      Layer.provide(layerFromDraft(draft)),
      Layer.provide(
        operations === undefined
          ? Layer.empty
          : Layer.succeed(WorkflowOperations, operations)
      )
    );
    const toolkit = yield* Effect.provide(agentToolkit, handlers);

    return { draft, toolkit } satisfies AgentToolSession;
  }
);

type AgentTools = Toolkit.Tools<typeof agentToolkit>;

/**
 * A refusal in the shape a handler answers, for a tool the caller may not use.
 *
 * Built here rather than by the tool, because the refusal is the caller's and
 * not the tool's: the model reads `{ reason }` as it reads any refused call,
 * and the panel shows the reason.
 */
function refusedToolResult<Name extends keyof AgentTools>(
  reason: string
): Tool.HandlerResult<AgentTools[Name]> {
  const refusal = { reason };
  const answer: Tool.HandlerResult<Tool.Any> = {
    result: refusal,
    encodedResult: refusal,
    isFailure: true,
    preliminary: false,
  };
  return answer;
}

/**
 * The session with each named tool answering a refusal instead of running.
 *
 * The model still sees every tool, so the system prompt's references to one
 * stay true; calling a refused one tells it why, and it can say so.
 */
export function withRefusedTools(
  session: AgentToolSession,
  refused: ReadonlySet<string>,
  reason: string
): AgentToolSession {
  if (refused.size === 0) {
    return session;
  }
  const { toolkit } = session;
  return {
    ...session,
    toolkit: {
      ...toolkit,
      handle: (name, parameters, toolCallId, options) =>
        refused.has(name)
          ? Effect.succeed(Stream.succeed(refusedToolResult(reason)))
          : toolkit.handle(name, parameters, toolCallId, options),
    },
  };
}
