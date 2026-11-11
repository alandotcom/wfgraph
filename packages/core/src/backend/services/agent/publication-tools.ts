/**
 * Publish, version history and restore for an MCP client, over the services
 * the editor's Publish button and version history call. Each answers the
 * draft revision the workflow holds afterwards, because publishing and
 * restoring both write the draft and the client's next write must carry it.
 */

import { Effect } from "effect";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { NotFound } from "#src/backend/lib/effect/failures";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { validateAgentDraft } from "#src/backend/agent/publication-validation";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { publishWorkflow } from "#src/backend/services/workflows/publish";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  getWorkflowVersionHistory,
  restoreWorkflowVersion,
} from "#src/backend/services/workflows/versions";

/** The most versions one list_versions call answers. */
const LISTED_VERSIONS = 20;

const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("agent").with({ workflowId })
  );

export type PublishDraftAnswer =
  | {
      readonly status: "published";
      readonly versionId: string;
      readonly version: number;
      readonly draftRevision: number;
    }
  | {
      readonly status: "blocked";
      /** Each publish blocker as one sentence naming its step. */
      readonly publishBlockers: readonly string[];
      readonly draftRevision: number;
    };

/**
 * Publishes the stored draft. A draft with publish blockers is answered with
 * them rather than sent to `publishWorkflow`, whose refusal names only the
 * first; the publish itself still runs every check and fences on both the
 * draft revision and the published version the draft was read against.
 */
export const publishStoredDraft = Effect.fn("wfgraph.agent.publish")(
  function* (input: {
    readonly workflowId: string;
    readonly expectedDraftRevision: number;
  }) {
    const workflows = yield* WorkflowRepo;
    const workflow = yield* workflows.findById(input.workflowId);
    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }
    const { catalog } = yield* Extensions;
    const integrations = yield* (yield* IntegrationRepo).listIdentities;
    const validation = validateAgentDraft({
      document: toWorkflowGraphData(workflow.graph),
      catalog,
      integrations,
    });
    const blockers = [
      ...validation.structuralIssues,
      ...validation.publishBlockers.map((issue) =>
        issue.nodeLabel === undefined
          ? issue.message
          : `${issue.nodeLabel}: ${issue.message}`
      ),
    ];
    if (blockers.length > 0) {
      return {
        status: "blocked",
        publishBlockers: blockers,
        draftRevision: workflow.draftRevision,
      } satisfies PublishDraftAnswer;
    }

    const published = yield* publishWorkflow({
      workflowId: workflow.id,
      graph: workflow.graph,
      expectedDraftRevision: input.expectedDraftRevision,
      expectedPublishedVersionId: workflow.publishedVersionId,
    });
    return {
      status: "published",
      versionId: published.publishedVersionId,
      version: published.publishedVersion,
      draftRevision: published.draftRevision,
    } satisfies PublishDraftAnswer;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(input.workflowId),
          "Failed to publish workflow"
        )
      )
    )
);

/** The workflow's most recent published versions, newest first. */
export const listPublishedVersions = Effect.fn("wfgraph.agent.list_versions")(
  function* (input: { readonly workflowId: string }) {
    const history = yield* getWorkflowVersionHistory({
      workflowId: input.workflowId,
      limit: LISTED_VERSIONS,
    });
    return {
      versions: history.items.map((item) => ({
        versionId: item.id,
        version: item.version,
        publishedAt: item.publishedAt,
        isCurrent: item.isCurrent,
      })),
    };
  }
);

/** Replaces the draft with a published version's graph. */
export const restorePublishedVersion = Effect.fn("wfgraph.agent.restore")(
  function* (input: {
    readonly workflowId: string;
    readonly versionId: string;
    readonly expectedDraftRevision: number;
  }) {
    const restored = yield* restoreWorkflowVersion(input);
    return { draftRevision: restored.draftRevision };
  }
);
