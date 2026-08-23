/**
 * One turn of the build agent, as a stream the RPC procedure hands to the
 * browser.
 *
 * Everything a turn needs arrives with the request: the conversation so far, the
 * graph the editor has open, and the connections the operator has made. Nothing
 * is kept between turns, so any server can answer any request.
 *
 * A `graph` part is emitted after every write tool, which is what makes the
 * canvas redraw as the agent works. The graph is read off the draft rather than
 * out of the tool's answer, so the editor always receives the whole document
 * even when a tool reports one sentence.
 */

import { Effect, Layer, Stream } from "effect";
import {
  Chat,
  type LanguageModel,
  Prompt,
  type Toolkit,
} from "effect/unstable/ai";
import {
  agentToolkit,
  agentToolkitLayer,
  WRITE_TOOL_NAMES,
} from "@wfgraph/agent/toolkit";
import {
  type AgentDocument,
  layerFromDraft,
  makeWorkflowDraft,
  type WorkflowDraftService,
} from "@wfgraph/agent/document";
import { buildSystemPrompt } from "@wfgraph/agent/prompt";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type {
  AgentMessage,
  AgentStreamPart,
} from "@wfgraph/shared/rpc/agent-stream";
import type { EnabledAgentSettings } from "#src/backend/agent/config";
import { agentModelLayer } from "#src/backend/agent/model";
import { toAgentStreamPart } from "#src/backend/agent/stream";
import { validateAgentPublication } from "#src/backend/agent/publication-validation";

/**
 * How many times a turn may go back to the model.
 *
 * A step is one model call plus whatever tools it asked for, so the agent needs
 * several: read the graph, search the catalog, describe an action, then write.
 * The cap is what stops a model that keeps calling tools from running a turn
 * forever on someone's key.
 */
const MAX_STEPS = 24;

type AgentStreamPartIn = Parameters<typeof toAgentStreamPart>[0];

export type AgentTurnInput = {
  readonly settings: EnabledAgentSettings;
  readonly catalog: ExtensionCatalog;
  readonly integrations: readonly { id: string; type: string }[];
  readonly document: AgentDocument;
  readonly messages: readonly AgentMessage[];
};

/**
 * The conversation, in the shape the language model takes it.
 *
 * The system prompt rides on the prompt rather than beside it, because
 * `LanguageModel.streamText` takes no separate system option.
 */
function toPrompt(input: {
  readonly messages: readonly AgentMessage[];
  readonly system: string;
}): Prompt.Prompt {
  return Prompt.make(
    input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))
  ).pipe(Prompt.setSystem(input.system));
}

/** The draft as the editor reads a graph, for a `graph` part. */
function graphPartOf(document: AgentDocument): AgentStreamPart {
  return {
    type: "graph",
    graph: createSerializedWorkflowGraph({
      nodes: [...document.nodes],
      edges: [...document.edges],
    }),
  };
}

/**
 * Runs one turn and answers the parts the panel renders.
 *
 * The stream is built inside an Effect so the draft is created once and the
 * write-tool watcher reads the same handle the tools write through.
 */
export function runAgentTurn(
  input: AgentTurnInput
): Effect.Effect<Stream.Stream<AgentStreamPart, unknown>> {
  return Effect.gen(function* () {
    const draft = yield* makeWorkflowDraft({
      document: input.document,
      catalog: input.catalog,
      integrations: input.integrations,
      validatePublication: (document) =>
        validateAgentPublication({
          document,
          catalog: input.catalog,
          integrations: input.integrations,
        }),
    });

    // The toolkit is resolved here, with the draft this turn writes through,
    // so the stream below carries no requirement of its own.
    const toolkit = yield* Effect.provide(
      agentToolkit,
      agentToolkitLayer.pipe(Layer.provide(layerFromDraft(draft)))
    );

    const session = yield* Chat.fromPrompt(
      toPrompt({
        messages: input.messages,
        system: buildSystemPrompt(input.catalog),
      })
    ).pipe(Effect.provide(agentModelLayer(input.settings)));

    const parts = agenticSteps({ session, toolkit, remaining: MAX_STEPS }).pipe(
      Stream.provide(agentModelLayer(input.settings))
    );

    return withGraphParts(parts, draft);
  });
}

/**
 * The turn as a loop: one model call, then another if it asked for a tool.
 *
 * `Chat` keeps the history, so each step sees the tool results of the one before
 * it. `streamText` answers a single round trip, which is why the loop is here:
 * without it the agent reads the graph, stops, and says nothing.
 *
 * The next step is decided by whether this one called a tool, which is only
 * known once the stream has finished, so it is read through a flag and the
 * continuation is suspended until then.
 */
function agenticSteps(input: {
  readonly session: Chat.Service;
  readonly toolkit: Toolkit.WithHandler<Toolkit.Tools<typeof agentToolkit>>;
  readonly remaining: number;
}): Stream.Stream<AgentStreamPartIn, unknown, LanguageModel.LanguageModel> {
  if (input.remaining <= 0) {
    // Ending quietly would leave the panel showing a column of tool calls and no
    // answer, which reads as the agent having crashed rather than having been
    // stopped. The failure is the caller's to see.
    return Stream.fail(
      new Error(
        `The agent stopped after ${MAX_STEPS} steps without finishing. Ask for a smaller change, or say what to do next.`
      )
    );
  }

  let calledTool = false;

  // An empty prompt continues the conversation the chat already holds: the tool
  // results of the previous step are in its history, and this step is the model
  // reading them.
  return input.session.streamText({ prompt: [], toolkit: input.toolkit }).pipe(
    Stream.tap((part) =>
      Effect.sync(() => {
        if (part.type === "tool-call") {
          calledTool = true;
        }
      })
    ),
    Stream.concat(
      Stream.suspend(() =>
        calledTool
          ? agenticSteps({ ...input, remaining: input.remaining - 1 })
          : Stream.empty
      )
    )
  );
}

/**
 * Every response part as a wire part, with the graph folded in after each write.
 *
 * A tool result names the tool, so the write set decides where the canvas has
 * something new to draw; a read tool leaves the graph as it found it and adds
 * nothing here.
 */
function withGraphParts(
  parts: Stream.Stream<AgentStreamPartIn, unknown>,
  draft: WorkflowDraftService
): Stream.Stream<AgentStreamPart, unknown> {
  return parts.pipe(
    Stream.mapEffect((part) =>
      Effect.gen(function* () {
        const mapped = toAgentStreamPart(part);
        if (!mapped) {
          return [];
        }

        if (
          mapped.type === "tool-result" &&
          !mapped.failed &&
          WRITE_TOOL_NAMES.has(mapped.name)
        ) {
          return [mapped, graphPartOf(yield* draft.current)];
        }

        return [mapped];
      })
    ),
    Stream.flattenIterable
  );
}
