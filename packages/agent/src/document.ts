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
import type { WorkflowGraphData } from "@wfgraph/shared/graph/types";
import { workflowTopologyRefusalReason } from "@wfgraph/shared/graph/workflow-topology";

/** The graph as one turn sees it: the nodes and edges, and nothing about layout. */
export type AgentDocument = WorkflowGraphData;

/** A connected integration the operator has already configured, by id and type. */
export type ConnectedIntegration = {
  readonly id: string;
  readonly type: string;
};

export type AgentValidationIssue = {
  readonly kind: string;
  readonly message: string;
  readonly nodeId?: string | undefined;
  readonly nodeLabel?: string | undefined;
};

export type AgentPublicationValidation = {
  readonly publishBlockers: readonly AgentValidationIssue[];
  readonly warnings: readonly AgentValidationIssue[];
};

export type AgentDraftValidation = AgentPublicationValidation & {
  readonly draftValid: boolean;
  readonly structuralIssues: readonly string[];
};

/** What `layerFromDocument` needs to answer every tool in the toolkit. */
export type WorkflowDraftInput = {
  readonly document: AgentDocument;
  readonly catalog: ExtensionCatalog;
  readonly integrations: readonly ConnectedIntegration[];
  /** Returns why a candidate cannot be stored, or null when it can be stored. */
  readonly validateUpdate: (document: AgentDocument) => string | null;
  readonly validateDraft: (document: AgentDocument) => AgentDraftValidation;
};

type DraftUpdateResult =
  | { readonly ok: true; readonly document: AgentDocument }
  | { readonly ok: false; readonly reason: string };

type WorkflowDraftState = {
  readonly document: AgentDocument;
  readonly revisions: readonly AgentDocument[];
};

export type WorkflowDraftService = {
  /** The graph as it stands after every edit made so far in this turn. */
  readonly current: Effect.Effect<AgentDocument>;
  /** Replace the graph and answer what it became. */
  readonly update: (
    edit: (document: AgentDocument) => AgentDocument
  ) => Effect.Effect<AgentDocument, { readonly reason: string }>;
  /** Read the immutable document stored after one successful update. */
  readonly revision: (revision: number) => Effect.Effect<AgentDocument>;
  /** The extension surface, fixed for the turn. */
  readonly catalog: ExtensionCatalog;
  /** The connections the operator can bind an action to, fixed for the turn. */
  readonly integrations: readonly ConnectedIntegration[];
  /** Runs the host's complete draft checks against the current snapshot. */
  readonly validateDraft: (document: AgentDocument) => AgentDraftValidation;
};

export class WorkflowDraft extends Context.Service<
  WorkflowDraft,
  WorkflowDraftService
>()("@wfgraph/agent/WorkflowDraft") {}

/**
 * One draft per request.
 *
 * The service is built as a value rather than only as a Layer, because the
 * caller needs the same handle the tools write through. Each accepted update
 * stores an ordered revision snapshot, which the request handler sends after
 * the matching write result. A Layer alone would seal the `Ref` inside it.
 */
export function makeWorkflowDraft(
  input: WorkflowDraftInput
): Effect.Effect<WorkflowDraftService> {
  return Effect.gen(function* () {
    const state = yield* Ref.make({
      document: input.document,
      revisions: [input.document] as readonly AgentDocument[],
    });

    return {
      current: Ref.get(state).pipe(Effect.map((snapshot) => snapshot.document)),
      update: (edit) =>
        Ref.modify(
          state,
          (current): [DraftUpdateResult, WorkflowDraftState] => {
            const candidate = edit(current.document);
            const reason =
              workflowTopologyRefusalReason(candidate) ??
              input.validateUpdate(candidate);
            return reason
              ? [{ ok: false as const, reason }, current]
              : [
                  { ok: true as const, document: candidate },
                  {
                    document: candidate,
                    revisions: [...current.revisions, candidate],
                  },
                ];
          }
        ).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.document)
              : Effect.fail({ reason: result.reason })
          )
        ),
      revision: (revision) =>
        Ref.get(state).pipe(
          Effect.flatMap((snapshot) => {
            const document = snapshot.revisions[revision];
            return document
              ? Effect.succeed(document)
              : Effect.die(
                  new Error(`Missing workflow draft revision ${revision}.`)
                );
          })
        ),
      catalog: input.catalog,
      integrations: input.integrations,
      validateDraft: input.validateDraft,
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
