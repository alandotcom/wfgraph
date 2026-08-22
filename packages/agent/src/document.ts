/**
 * The workflow the build agent reads and edits during one chat turn.
 *
 * The document is a snapshot the browser sends with the turn, held in a `Ref`
 * for the life of one request and thrown away with it. Nothing here is shared
 * between turns or between servers: the canonical graph lives in the editor and
 * in the database, and a turn hands its result back for the editor to apply.
 *
 * Every tool handler reaches the graph through this service, so a tool never
 * touches a database, an HTTP client or a model.
 */

import { Context, Effect, Layer, Ref } from "effect";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { workflowTopologyRefusalReason } from "@wfgraph/shared/graph/workflow-topology";

/** The graph as one turn sees it: the nodes and edges, and nothing about layout. */
export type AgentDocument = {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
};

/** A connected integration the operator has already configured, by id and type. */
export type ConnectedIntegration = {
  readonly id: string;
  readonly type: string;
};

/** What `layerFromDocument` needs to answer every tool in the toolkit. */
export type WorkflowDraftInput = {
  readonly document: AgentDocument;
  readonly catalog: ExtensionCatalog;
  readonly integrations: readonly ConnectedIntegration[];
};

type DraftUpdateResult =
  | { readonly ok: true; readonly document: AgentDocument }
  | { readonly ok: false; readonly reason: string };

export type WorkflowDraftService = {
  /** The graph as it stands after every edit made so far in this turn. */
  readonly current: Effect.Effect<AgentDocument>;
  /** Replace the graph and answer what it became. */
  readonly update: (
    edit: (document: AgentDocument) => AgentDocument
  ) => Effect.Effect<AgentDocument, { readonly reason: string }>;
  /** The extension surface, fixed for the turn. */
  readonly catalog: ExtensionCatalog;
  /** The connections the operator can bind an action to, fixed for the turn. */
  readonly integrations: readonly ConnectedIntegration[];
};

export class WorkflowDraft extends Context.Service<
  WorkflowDraft,
  WorkflowDraftService
>()("@wfgraph/agent/WorkflowDraft") {}

/**
 * One draft per request.
 *
 * The service is built as a value rather than only as a Layer, because the
 * caller needs the same handle the tools write through: after each write tool
 * returns, the request handler reads `current` to send the editor the graph as
 * it now stands. A Layer alone would seal the `Ref` inside it.
 */
export function makeWorkflowDraft(
  input: WorkflowDraftInput
): Effect.Effect<WorkflowDraftService> {
  return Effect.gen(function* () {
    const state = yield* Ref.make(input.document);

    return {
      current: Ref.get(state),
      update: (edit) =>
        Ref.modify(state, (current): [DraftUpdateResult, AgentDocument] => {
          const candidate = edit(current);
          const reason = workflowTopologyRefusalReason(candidate);
          return reason
            ? [{ ok: false as const, reason }, current]
            : [{ ok: true as const, document: candidate }, candidate];
        }).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.document)
              : Effect.fail({ reason: result.reason })
          )
        ),
      catalog: input.catalog,
      integrations: input.integrations,
    };
  });
}

/**
 * The draft as a Layer, for providing to the toolkit.
 *
 * Never put this on an application runtime: a `ManagedRuntime` layer outlives
 * every request, and a draft on one would leak a caller's graph into the next
 * caller's turn.
 */
export function layerFromDraft(
  draft: WorkflowDraftService
): Layer.Layer<WorkflowDraft> {
  return Layer.succeed(WorkflowDraft, draft);
}
