/** Executes one canonical authoring tool against one persisted workflow draft. */

import { Effect, Option, Stream } from "effect";
import {
  agentToolkit,
  CATALOG_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from "@wfgraph/agent/toolkit";
import {
  serializeWorkflowGraphData,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import { placeNewWorkflowNodes } from "@wfgraph/shared/graph/workflow-placement";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  type AgentToolSession,
  makeAgentToolSession,
} from "#src/backend/agent/tool-session";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  DraftConflict,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { validateAgentDraft } from "#src/backend/agent/publication-validation";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { buildWorkflowUpdateData } from "#src/backend/services/workflows/mappers";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

export type AgentToolName = keyof typeof agentToolkit.tools;

export type ExecuteDraftToolInput = {
  /** The draft to run against. A catalog tool takes none and reads no draft. */
  readonly workflowId?: string | undefined;
  readonly name: AgentToolName;
  readonly arguments: JsonObject;
  readonly toolCallId: string;
  readonly expectedDraftRevision?: number | undefined;
};

export type DraftToolResult = {
  /** Absent for a catalog tool, which reads no draft. */
  readonly workflowId?: string | undefined;
  readonly draftRevision?: number | undefined;
  readonly result: JsonObject;
  readonly isFailure: boolean;
};

const loggerFor = (workflowId: string | undefined) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("agent").with(omitUndefined({ workflowId }))
  );

/**
 * The refusal of a write sent against a revision other than the stored one.
 * It says which way the revisions differ, because a revision ahead of the
 * stored draft is a client bookkeeping error rather than another writer, and
 * it names the read that recovers either case. Nothing was written.
 */
function staleDraft(input: {
  readonly expected: number;
  readonly current: number;
}): DraftConflict {
  const reread =
    "Nothing was written. Call read_workflow, decide the edit again against the graph it returns, and send it with that draftRevision.";
  return new DraftConflict({
    error:
      input.expected < input.current
        ? `The workflow draft changed after revision ${input.expected} and is now at revision ${input.current}. ${reread}`
        : `Revision ${input.expected} is ahead of the stored draft, which is at revision ${input.current}; send the draftRevision from the latest read or write. ${reread}`,
    currentDraftRevision: input.current,
  });
}

/** Runs one toolkit handler and requires its declared object result. */
function runTool(session: AgentToolSession, input: ExecuteDraftToolInput) {
  return session.toolkit
    .handle(input.name, input.arguments, input.toolCallId)
    .pipe(
      Effect.flatMap(Stream.runLast),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("The tool handler returned no result"),
          onSome: Effect.succeed,
        })
      ),
      Effect.map((result) => {
        const resultObject = readJsonObject(result.encodedResult);
        if (!resultObject) {
          throw new Error("The tool returned a non-object result");
        }
        return { result: resultObject, isFailure: result.isFailure };
      }),
      // A parameter failure names the field and what it expected, as the
      // built-in agent reads it; Effect leaves the rejected value out.
      Effect.catchTag(
        "AiError",
        (error) =>
          new InvalidInput({
            error:
              error.reason._tag === "ToolParameterValidationError"
                ? `Invalid arguments for ${input.name}: ${error.reason.description}`
                : `Tool ${input.name} failed: ${error.reason.message}`,
          })
      )
    );
}

/**
 * Loads one draft, executes one tool, and conditionally stores one graph,
 * with each step the tool added placed beside its neighbours. Every
 * invocation owns a new tool session and reads all shared state from
 * application services.
 */
export const executeDraftTool = Effect.fn("wfgraph.agent.draft_tool")(
  function* (input: ExecuteDraftToolInput) {
    const { catalog } = yield* Extensions;
    const integrations = yield* (yield* IntegrationRepo).listIdentities;

    if (CATALOG_TOOL_NAMES.has(input.name)) {
      const session = yield* makeAgentToolSession({
        document: { nodes: [], edges: [] },
        catalog,
        integrations,
        validateDraft: (document) =>
          validateAgentDraft({ document, catalog, integrations }),
      });
      const answered = yield* runTool(session, input);
      return {
        workflowId: undefined,
        draftRevision: undefined,
        ...answered,
      } satisfies DraftToolResult;
    }

    if (input.workflowId === undefined) {
      return yield* new InvalidInput({
        error: `${input.name} requires workflowId`,
      });
    }
    const workflows = yield* WorkflowRepo;
    const workflow = yield* workflows.findById(input.workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const writesGraph = WRITE_TOOL_NAMES.has(input.name);
    if (writesGraph && input.expectedDraftRevision === undefined) {
      return yield* new InvalidInput({
        error: "Expected draft revision is required for a graph update",
      });
    }
    if (
      writesGraph &&
      input.expectedDraftRevision !== undefined &&
      workflow.draftRevision !== input.expectedDraftRevision
    ) {
      return yield* staleDraft({
        expected: input.expectedDraftRevision,
        current: workflow.draftRevision,
      });
    }

    const session = yield* makeAgentToolSession({
      document: toWorkflowGraphData(workflow.graph),
      catalog,
      integrations,
      validateDraft: (document) =>
        validateAgentDraft({ document, catalog, integrations }),
    });
    const toolResult = yield* runTool(session, input);

    if (toolResult.isFailure || !writesGraph) {
      return {
        workflowId: workflow.id,
        draftRevision: workflow.draftRevision,
        ...toolResult,
      } satisfies DraftToolResult;
    }

    // Only the steps this call added are placed; every step already stored
    // keeps the position a person or an earlier write gave it.
    const document = yield* session.draft.current;
    const storedIds = new Set(workflow.graph.nodes.map((node) => node.key));
    const placed = placeNewWorkflowNodes({
      nodes: [...document.nodes],
      edges: [...document.edges],
      catalog,
      unplacedIds: new Set(
        document.nodes
          .filter((node) => !storedIds.has(node.id))
          .map((node) => node.id)
      ),
    });
    const prepared = yield* prepareGraphSave({
      graph: serializeWorkflowGraphData({
        nodes: placed,
        edges: [...document.edges],
      }),
    });
    const expectedDraftRevision = input.expectedDraftRevision;
    if (expectedDraftRevision === undefined) {
      return yield* new InvalidInput({
        error: "Expected draft revision is required for a graph update",
      });
    }
    const write = yield* workflows.writeDraft({
      workflowId: workflow.id,
      expectedDraftRevision,
      updates: {
        ...buildWorkflowUpdateData({ graph: prepared.graph }),
        graph: prepared.graph,
      },
    });
    if (write.status === "conflict") {
      return yield* staleDraft({
        expected: expectedDraftRevision,
        current: write.currentDraftRevision,
      });
    }
    if (write.status === "not_found") {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    return {
      workflowId: workflow.id,
      draftRevision: write.workflow.draftRevision,
      ...toolResult,
    } satisfies DraftToolResult;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to execute workflow authoring tool"
        )
      )
    )
);
