/**
 * The harness every tool test stands on: a draft built from a fixture graph, and
 * the tool handlers bound to it.
 *
 * No model is involved. A tool is a schema plus a handler over `WorkflowDraft`,
 * so a test provides a draft and calls a handler. Handlers are called directly
 * rather than routed through `Toolkit.handle`, because a handler's signature is
 * exact: it answers its success type, and its error channel holds the failure
 * the tool declares. Whether the schemas around them are well formed is a
 * separate question, and `toolkit.test.ts` is where it is asked.
 *
 * Reachable from no entry point outside this package's own tests.
 */

import { Effect } from "effect";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  type AgentDocument,
  type AgentDraftValidation,
  type ConnectedIntegration,
  layerFromDraft,
  makeWorkflowDraft,
  type WorkflowDraftService,
} from "#src/document";
import {
  WorkflowOperations,
  type WorkflowOperationsService,
} from "#src/operations";
import { agentToolHandlers } from "#src/toolkit";

export type ToolTestInput = {
  readonly nodes?: readonly WorkflowNode[];
  readonly edges?: readonly WorkflowEdge[];
  readonly catalog: ExtensionCatalog;
  readonly integrations?: readonly ConnectedIntegration[];
  readonly validateUpdate?: (document: AgentDocument) => string | null;
  readonly validateDraft?: (document: AgentDocument) => AgentDraftValidation;
  /** The host operations the run tools ask; absent, each one refuses. */
  readonly operations?: WorkflowOperationsService;
};

export type AgentToolHandlers = Effect.Success<typeof agentToolHandlers>;

export type ToolTestSubject = {
  readonly tools: AgentToolHandlers;
  /** The same draft the handlers write through, for reading the graph after. */
  readonly draft: WorkflowDraftService;
};

export function agentToolsFor(
  input: ToolTestInput
): Effect.Effect<ToolTestSubject> {
  return Effect.gen(function* () {
    const draft = yield* makeWorkflowDraft({
      document: { nodes: input.nodes ?? [], edges: input.edges ?? [] },
      catalog: input.catalog,
      integrations: input.integrations ?? [],
      validateUpdate: input.validateUpdate ?? (() => null),
      // Every write reads the draft checks to report what it introduced, so
      // the default is a draft with nothing to report.
      validateDraft:
        input.validateDraft ??
        (() => ({
          draftValid: true,
          structuralIssues: [],
          publishBlockers: [],
          warnings: [],
        })),
    });

    const handlers = Effect.provide(agentToolHandlers, layerFromDraft(draft));
    const tools = yield* input.operations === undefined
      ? handlers
      : Effect.provideService(handlers, WorkflowOperations, input.operations);

    return { tools, draft };
  });
}
