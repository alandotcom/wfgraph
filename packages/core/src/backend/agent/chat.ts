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

import { Effect, Stream } from "effect";
import {
  Chat,
  type LanguageModel,
  Prompt,
  type Toolkit,
} from "effect/unstable/ai";
import { agentToolkit, WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import type { AgentDocument } from "@wfgraph/agent/document";
import { buildSystemPrompt } from "@wfgraph/agent/prompt";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type {
  AgentMessage,
  AgentStreamPart,
} from "@wfgraph/shared/rpc/agent-stream";
import type { EnabledAgentSettings } from "#src/backend/agent/config";
import { agentModelLayer } from "#src/backend/agent/model";
import type { AgentRunner, AgentRunnerInput } from "#src/backend/agent/runner";
import type { AgentToolSession } from "#src/backend/agent/tool-session";
import {
  AGENT_TURN_STEP_LIMIT,
  runAgentStepLoop,
} from "#src/backend/agent/step-loop";
import { toAgentStreamPart } from "#src/backend/agent/stream";
import {
  finishReasonFailure,
  traceResponsePart,
  type AgentTraceObserver,
} from "#src/backend/agent/trace";

type AgentStreamPartIn = Parameters<typeof toAgentStreamPart>[0];

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
 * The runner uses the toolkit and draft from the request-scoped tool session.
 * The write-tool watcher reads the same draft that the handlers update.
 */
function runBuiltInAgentTurn(
  settings: EnabledAgentSettings,
  input: AgentRunnerInput
): Effect.Effect<Stream.Stream<AgentStreamPart, unknown>> {
  return Effect.gen(function* () {
    const session = yield* Chat.fromPrompt(
      toPrompt({
        messages: input.messages,
        system: buildSystemPrompt(),
      })
    ).pipe(Effect.provide(agentModelLayer(settings)));

    const parts = agenticSteps({
      session,
      toolkit: input.session.toolkit,
      observeTrace: input.observeTrace,
    }).pipe(Stream.provide(agentModelLayer(settings)));

    return withGraphParts(parts, input.session, input.observeTrace);
  });
}

/** The default runner backed by the configured Effect AI model. */
export function makeBuiltInAgentRunner(
  settings: EnabledAgentSettings
): AgentRunner {
  return {
    metadata: { provider: "openai", model: settings.model },
    run: (input) => runBuiltInAgentTurn(settings, input),
  };
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
export function agenticSteps(input: {
  readonly session: Chat.Service;
  readonly toolkit: Toolkit.WithHandler<Toolkit.Tools<typeof agentToolkit>>;
  readonly observeTrace: AgentTraceObserver;
}): Stream.Stream<SteppedAgentPart, unknown, LanguageModel.LanguageModel> {
  // An empty prompt continues the conversation the chat already holds: the tool
  // results of the previous step are in its history, and this step is the model
  // reading them.
  return runAgentStepLoop({
    limit: AGENT_TURN_STEP_LIMIT,
    step: (step) => {
      return input.session
        .streamText({ prompt: [], toolkit: input.toolkit, concurrency: 1 })
        .pipe(Stream.map((part) => ({ step, part })));
    },
    calledTool: ({ part }) => part.type === "tool-call",
    stepCompletion: ({ part }) => {
      if (part.type !== "finish") {
        return undefined;
      }
      return {
        calledTool: part.reason === "tool-calls",
        failure: finishReasonFailure(part.reason),
      };
    },
    stepFailure: ({ part }) =>
      part.type === "error" ? finishReasonFailure("error") : undefined,
    onStepStart: (startedStep) =>
      input.observeTrace({ type: "model-step-start", step: startedStep }),
  });
}

export type SteppedAgentPart = {
  readonly step: number;
  readonly part: AgentStreamPartIn;
};

/**
 * Every response part as a wire part, with the graph folded in after each write.
 *
 * A tool result names the tool, so the write set decides where the canvas has
 * something new to draw; a read tool leaves the graph as it found it and adds
 * nothing here.
 */
export function withGraphParts(
  parts: Stream.Stream<SteppedAgentPart, unknown>,
  session: Pick<AgentToolSession, "recordGraphRevision">,
  observeTrace: AgentTraceObserver
): Stream.Stream<AgentStreamPart, unknown> {
  return parts.pipe(
    Stream.mapEffect(({ part, step }) =>
      Effect.gen(function* () {
        const writesGraph =
          part.type === "tool-result" &&
          !part.isFailure &&
          WRITE_TOOL_NAMES.has(part.name);
        const graphRevision = writesGraph
          ? yield* session.recordGraphRevision()
          : undefined;
        const traceEvent = traceResponsePart({
          step,
          part,
          graphRevision: graphRevision?.revision,
        });
        if (traceEvent) {
          observeTrace(traceEvent);
        }

        // The step loop turns a provider error or error finish into one safe
        // browser error, so the provider part stays out of the browser stream.
        const mapped =
          part.type === "error" ? undefined : toAgentStreamPart(part);
        if (!mapped) {
          return [];
        }

        if (writesGraph && graphRevision !== undefined) {
          observeTrace({
            type: "graph-revision",
            step,
            toolCallId: part.id,
            revision: graphRevision.revision,
            document: graphRevision.document,
          });
          return [mapped, graphPartOf(graphRevision.document)];
        }

        return [mapped];
      })
    ),
    Stream.flattenIterable
  );
}
