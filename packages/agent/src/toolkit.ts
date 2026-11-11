/**
 * Every tool the build agent may call, in one toolkit.
 *
 * `agentToolkitLayer` supplies the handlers and requires `WorkflowDraft`, so the
 * toolkit is bound to one turn's document. Provide it where the request is
 * handled and let it fall out of scope with the request.
 */

import { Effect } from "effect";
import { WorkflowDraft } from "#src/document";
import { Toolkit } from "effect/ai";
import {
  catalogToolHandlers,
  DescribeAction,
  DescribeEvent,
  ListActions,
  ListEvents,
  ListIntegrations,
} from "#src/tools/catalog-tools";
import {
  graphReadToolHandlers,
  ReadNodes,
  ReadWorkflow,
  ValidateWorkflow,
} from "#src/tools/graph-read-tools";
import {
  AddNode,
  ConnectNodes,
  DeleteNode,
  DisconnectNodes,
  graphWriteToolHandlers,
  InsertNodeOnEdge,
  RevertDraft,
  UpdateNode,
} from "#src/tools/graph-write-tools";
import {
  lifecycleToolHandlers,
  SetCondition,
  SetLifecycleRules,
} from "#src/tools/lifecycle-tools";
import {
  ListReferences,
  referenceToolHandlers,
} from "#src/tools/reference-tools";
import { SetWait, waitToolHandlers } from "#src/tools/wait-tools";
import { ApplyEdits, applyEditsHandler } from "#src/tools/batch-tools";
import {
  ListFieldOptions,
  ListRuns,
  ReadRun,
  runToolHandlers,
  StartTestRun,
} from "#src/tools/run-tools";
import { issuesIntroduced, type NewIssue } from "#src/tools/new-issues";

export const agentToolkit = Toolkit.make(
  ListActions,
  DescribeAction,
  DescribeEvent,
  ListEvents,
  ListIntegrations,
  ReadWorkflow,
  ReadNodes,
  ValidateWorkflow,
  ListReferences,
  ListFieldOptions,
  ListRuns,
  ReadRun,
  StartTestRun,
  AddNode,
  UpdateNode,
  DeleteNode,
  ConnectNodes,
  DisconnectNodes,
  InsertNodeOnEdge,
  ApplyEdits,
  RevertDraft,
  SetLifecycleRules,
  SetCondition,
  SetWait
);

/**
 * Every handler, assembled over one draft.
 *
 * Named separately from the layer because a test calls these directly: a
 * handler's own signature is exact, where a call routed by name through
 * `Toolkit.handle` answers a union of the success, the declared failure and an
 * `AiError` that no structural check can separate.
 */
export const agentToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;
  const catalog = yield* catalogToolHandlers;
  const graphRead = yield* graphReadToolHandlers;
  const references = yield* referenceToolHandlers;
  const graphWrite = yield* graphWriteToolHandlers;
  const lifecycle = yield* lifecycleToolHandlers;
  const wait = yield* waitToolHandlers;
  const runs = yield* runToolHandlers;

  /**
   * A write handler that also answers the validation issues its edit
   * introduced, read from the host's draft checks before and after it.
   */
  const reportingNewIssues =
    <I, A extends object, E>(
      handler: (input: I) => Effect.Effect<A, E>
    ): ((input: I) => Effect.Effect<A & { newIssues?: NewIssue[] }, E>) =>
    (input) =>
      Effect.gen(function* () {
        const before = draft.validateDraft(yield* draft.current);
        const result = yield* handler(input);
        const after = draft.validateDraft(yield* draft.current);
        const newIssues = issuesIntroduced({ before, after });
        return newIssues.length === 0 ? result : { ...result, newIssues };
      });

  return {
    ...catalog,
    ...graphRead,
    ...references,
    ...runs,
    revert_draft: reportingNewIssues(graphWrite.revert_draft),
    add_node: reportingNewIssues(graphWrite.add_node),
    update_node: reportingNewIssues(graphWrite.update_node),
    delete_node: reportingNewIssues(graphWrite.delete_node),
    connect_nodes: reportingNewIssues(graphWrite.connect_nodes),
    disconnect_nodes: reportingNewIssues(graphWrite.disconnect_nodes),
    insert_node_on_edge: reportingNewIssues(graphWrite.insert_node_on_edge),
    apply_edits: reportingNewIssues(
      applyEditsHandler({
        draft,
        handlersFor: (scratch) =>
          Effect.provideService(graphWriteToolHandlers, WorkflowDraft, scratch),
      })
    ),
    set_lifecycle_rules: reportingNewIssues(lifecycle.set_lifecycle_rules),
    set_condition: reportingNewIssues(lifecycle.set_condition),
    set_wait: reportingNewIssues(wait.set_wait),
  };
});

export const agentToolkitLayer = agentToolkit.toLayer(agentToolHandlers);

/**
 * The tools that change the graph.
 *
 * The caller streaming a turn reads this to know when the editor has something
 * new to draw. It is a set of names rather than a flag on each tool because a
 * `Tool` carries no room for one, and the toolkit test holds every name here to
 * a tool that exists.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  AddNode.name,
  UpdateNode.name,
  DeleteNode.name,
  ConnectNodes.name,
  DisconnectNodes.name,
  InsertNodeOnEdge.name,
  ApplyEdits.name,
  RevertDraft.name,
  SetLifecycleRules.name,
  SetCondition.name,
  SetWait.name,
]);

/**
 * The tools that read the host's catalog and never the draft. Their answers
 * are the same for every workflow, so an MCP client may call them before it
 * has created or chosen one.
 */
export const CATALOG_TOOL_NAMES: ReadonlySet<string> = new Set([
  ListActions.name,
  DescribeAction.name,
  ListEvents.name,
  DescribeEvent.name,
  ListIntegrations.name,
]);
