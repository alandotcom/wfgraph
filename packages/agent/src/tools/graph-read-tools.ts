/**
 * The three tools that answer "what does this workflow look like right now".
 *
 * `read_workflow` speaks the vocabulary a tool writes back in: node ids, the
 * four node types, and the action id a node's config carries. Positions are left
 * out on purpose, because the editor lays the graph out and the agent never
 * chooses coordinates.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { persistedNodeEnabled } from "@wfgraph/shared/graph/node-enabled";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  type JsonObject,
  jsonObjectSchema,
  readJsonObject,
} from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { WorkflowDraft } from "#src/document";
import {
  pageResults,
  resultLimitSchema,
  resultOffsetSchema,
} from "#src/tools/result-page";

const graphNodeSummarySchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** One of lifecycle, action, add or group. */
  type: Schema.String,
  /** The action a node runs, present on action nodes alone. */
  actionType: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** False when the node is switched off and the run walks past it. */
  enabled: Schema.optionalKey(Schema.Boolean),
});

const graphNodeDetailSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** One of lifecycle, action, add or group. */
  type: Schema.String,
  /** The action a node runs, present on action nodes alone. */
  actionType: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** False when the node is switched off and a run walks past it. */
  enabled: Schema.optionalKey(Schema.Boolean),
  config: jsonObjectSchema,
});

const graphEdgeSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  target: Schema.String,
  /** "true" or "false" out of a Condition, or a Lifecycle outlet name. */
  sourceHandle: Schema.optionalKey(Schema.String),
});

/**
 * The host's own `AgentValidationIssue` passes through this Tool's success
 * schema unchanged, so `nodeId` and `nodeLabel` are `Schema.optional`: the
 * host builds that value in process and may set either key to `undefined`
 * explicitly rather than omitting it.
 */
const issueSchema = Schema.Struct({
  kind: Schema.String,
  nodeId: Schema.optional(Schema.String),
  nodeLabel: Schema.optional(Schema.String),
  message: Schema.String,
});

/**
 * A node's config as JSON, which is what it is: the document arrived decoded
 * from a request body.
 *
 * A live editor config can still hold `undefined` for a key the operator
 * cleared, and that is not JSON, so those keys are dropped before the read
 * rather than sinking the whole bag to `null`.
 */
function readableConfig(node: WorkflowNode): JsonObject {
  const config = node.data.config ?? {};
  return readJsonObject(omitUndefined(config)) ?? {};
}

function readableNodeSummary(node: WorkflowNode) {
  return omitUndefined({
    id: node.id,
    label: node.data.label,
    type: node.data.type,
    actionType: actionTypeOf(node),
    description: node.data.description,
    enabled: persistedNodeEnabled(node.data.enabled),
  });
}

function readableNodeDetail(node: WorkflowNode) {
  return { ...readableNodeSummary(node), config: readableConfig(node) };
}

function readableEdge(edge: {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null | undefined;
}) {
  return omitUndefined({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
  });
}

export const ReadWorkflow = Tool.make("read_workflow", {
  description:
    "Read the workflow topology in bounded pages: compact node identities and edges. Use read_nodes for selected node config. Node positions are omitted because the editor owns layout.",
  parameters: Schema.Struct({
    nodeOffset: Schema.optionalKey(
      resultOffsetSchema.annotate({
        description: "Zero-based node offset for the next page.",
      })
    ),
    edgeOffset: Schema.optionalKey(
      resultOffsetSchema.annotate({
        description: "Zero-based edge offset for the next page.",
      })
    ),
    limit: Schema.optionalKey(
      resultLimitSchema.annotate({
        description:
          "Maximum nodes and edges to return, from 1 through 50. Defaults to 20.",
      })
    ),
  }),
  success: Schema.Struct({
    nodes: Schema.Array(graphNodeSummarySchema),
    edges: Schema.Array(graphEdgeSchema),
    totalNodes: Schema.Number,
    totalEdges: Schema.Number,
    nextNodeOffset: Schema.optionalKey(Schema.Number),
    nextEdgeOffset: Schema.optionalKey(Schema.Number),
  }),
});

export const ReadNodes = Tool.make("read_nodes", {
  description:
    "Read full config for selected nodes after read_workflow identifies their ids. At most 20 node ids may be read per call.",
  parameters: Schema.Struct({
    nodeIds: Schema.Array(Schema.String).annotate({
      description: "One to 20 exact node ids returned by read_workflow.",
    }),
  }),
  success: Schema.Struct({ nodes: Schema.Array(graphNodeDetailSchema) }),
  failure: Schema.Struct({ reason: Schema.String }),
  failureMode: "return",
});

export const ValidateWorkflow = Tool.make("validate_workflow", {
  description:
    "Check draft structure separately from the backend's canonical publication blockers and permitted warnings. Run this after edits and before describing completion.",
  success: Schema.Struct({
    draftValid: Schema.Boolean.annotate({
      description: "Whether the graph structure is valid enough to save.",
    }),
    structuralIssues: Schema.Array(Schema.String).annotate({
      description: "Graph structure problems that keep the draft from saving.",
    }),
    publishBlockers: Schema.Array(issueSchema).annotate({
      description:
        "Configuration or workflow problems that must be fixed before publication.",
    }),
    warnings: Schema.Array(issueSchema).annotate({
      description:
        "Problems worth fixing that the canonical publication gate permits.",
    }),
  }),
});

export const graphReadToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    read_workflow: (input: {
      readonly nodeOffset?: number | undefined;
      readonly edgeOffset?: number | undefined;
      readonly limit?: number | undefined;
    }) =>
      Effect.map(draft.current, (document) => {
        const nodes = pageResults(document.nodes, {
          offset: input.nodeOffset,
          limit: input.limit,
        });
        const edges = pageResults(document.edges, {
          offset: input.edgeOffset,
          limit: input.limit,
        });
        return omitUndefined({
          nodes: nodes.items.map(readableNodeSummary),
          edges: edges.items.map(readableEdge),
          totalNodes: nodes.total,
          totalEdges: edges.total,
          nextNodeOffset: nodes.nextOffset,
          nextEdgeOffset: edges.nextOffset,
        });
      }),

    read_nodes: (input: { readonly nodeIds: readonly string[] }) =>
      Effect.flatMap(draft.current, (document) => {
        if (input.nodeIds.length === 0 || input.nodeIds.length > 20) {
          return Effect.fail({
            reason: "read_nodes requires between 1 and 20 node ids.",
          });
        }
        const nodesById = new Map(
          document.nodes.map((node) => [node.id, node])
        );
        const missing = input.nodeIds.find((nodeId) => !nodesById.has(nodeId));
        if (missing) {
          return Effect.fail({
            reason: `No node with id ${missing}. Call read_workflow to see what the graph holds.`,
          });
        }

        return Effect.succeed({
          nodes: input.nodeIds.flatMap((nodeId) => {
            const node = nodesById.get(nodeId);
            return node ? [readableNodeDetail(node)] : [];
          }),
        });
      }),

    validate_workflow: () => Effect.map(draft.current, draft.validateDraft),
  };
});
