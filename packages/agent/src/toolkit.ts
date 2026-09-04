/**
 * Every tool the build agent may call, in one toolkit.
 *
 * `agentToolkitLayer` supplies the handlers and requires `WorkflowDraft`, so the
 * toolkit is bound to one turn's document. Provide it where the request is
 * handled and let it fall out of scope with the request.
 */

import { Effect } from "effect";
import { Toolkit } from "effect/unstable/ai";
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
  AddNode,
  UpdateNode,
  DeleteNode,
  ConnectNodes,
  DisconnectNodes,
  InsertNodeOnEdge,
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
  const catalog = yield* catalogToolHandlers;
  const graphRead = yield* graphReadToolHandlers;
  const references = yield* referenceToolHandlers;
  const graphWrite = yield* graphWriteToolHandlers;
  const lifecycle = yield* lifecycleToolHandlers;
  const wait = yield* waitToolHandlers;
  return {
    ...catalog,
    ...graphRead,
    ...references,
    ...graphWrite,
    ...lifecycle,
    ...wait,
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
  SetLifecycleRules.name,
  SetCondition.name,
  SetWait.name,
]);
