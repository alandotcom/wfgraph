/** Executes one canonical authoring tool against one persisted workflow draft. */

import { Effect, Option, Stream } from "effect";
import { agentToolkit, WRITE_TOOL_NAMES } from "@wfgraph/agent/toolkit";
import {
  serializeWorkflowGraphData,
  toWorkflowGraphData,
} from "@wfgraph/shared/graph/graph";
import { layoutWorkflowNodes } from "@wfgraph/shared/graph/workflow-layout";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { readJsonObject } from "@wfgraph/shared/types/json";
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
  readonly workflowId: string;
  readonly name: AgentToolName;
  readonly arguments: JsonObject;
  readonly toolCallId: string;
  readonly expectedDraftRevision?: number | undefined;
};

export type DraftToolResult = {
  readonly workflowId: string;
  readonly draftRevision: number;
  readonly result: JsonObject;
  readonly isFailure: boolean;
};

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("agent").with({ workflowId })
  );

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
      Effect.catchTag(
        "AiError",
        () => new InvalidInput({ error: "Tool arguments are invalid" })
      )
    );
}

/**
 * Loads one draft, executes one tool, and conditionally stores one laid-out
 * graph. Every invocation owns a new tool session and reads all shared state
 * from application services.
 */
export const executeDraftTool = Effect.fn("wfgraph.agent.draft_tool")(
  function* (input: ExecuteDraftToolInput) {
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
    if (writesGraph && workflow.draftRevision !== input.expectedDraftRevision) {
      return yield* new DraftConflict({
        error: "The workflow draft changed. Read it again before editing.",
        currentDraftRevision: workflow.draftRevision,
      });
    }

    const { catalog } = yield* Extensions;
    const integrations = yield* (yield* IntegrationRepo).listIdentities;
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

    const document = yield* session.draft.current;
    const laidOut = layoutWorkflowNodes({
      nodes: [...document.nodes],
      edges: [...document.edges],
      catalog,
    });
    const prepared = yield* prepareGraphSave({
      graph: serializeWorkflowGraphData({
        nodes: laidOut.nodes,
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
      return yield* new DraftConflict({
        error: "The workflow draft changed. Read it again before editing.",
        currentDraftRevision: write.currentDraftRevision,
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
