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
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  collectWorkflowIssues,
  hasBlockingWorkflowIssues,
} from "@wfgraph/shared/graph/workflow-issues";
import {
  type JsonObject,
  jsonObjectSchema,
  readJsonObject,
} from "@wfgraph/shared/types/json";
import { WorkflowDraft } from "#src/document";

const graphNodeSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** One of lifecycle, action, add or group. */
  type: Schema.String,
  /** The action a node runs, present on action nodes alone. */
  actionType: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** False when the node is switched off and the run walks past it. */
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

const issueSchema = Schema.Struct({
  kind: Schema.String,
  severity: Schema.String,
  nodeId: Schema.String,
  nodeLabel: Schema.String,
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
  const present = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined)
  );
  return readJsonObject(present) ?? {};
}

export const ReadWorkflow = Tool.make("read_workflow", {
  description:
    "The workflow as it stands: every node with its id, label, action and config, and every edge. Node positions are left out because the editor lays the graph out itself.",
  success: Schema.Struct({
    nodes: Schema.Array(graphNodeSchema),
    edges: Schema.Array(graphEdgeSchema),
  }),
});

export const ValidateWorkflow = Tool.make("validate_workflow", {
  description:
    "Check the workflow for missing required fields, actions whose integration has no connection, and template references pointing at nodes that are gone. Run this before telling the user the workflow is ready.",
  success: Schema.Struct({
    issues: Schema.Array(issueSchema),
    /** True when at least one issue would stop the workflow being published. */
    hasBlockingIssues: Schema.Boolean,
  }),
});

export const graphReadToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    read_workflow: () =>
      Effect.map(draft.current, (document) => ({
        nodes: document.nodes.map((node) => {
          const actionType = actionTypeOf(node);
          return {
            id: node.id,
            label: node.data.label,
            type: node.data.type,
            ...(actionType === undefined ? {} : { actionType }),
            ...(node.data.description === undefined
              ? {}
              : { description: node.data.description }),
            ...(node.data.enabled === undefined
              ? {}
              : { enabled: node.data.enabled }),
            config: readableConfig(node),
          };
        }),
        edges: document.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(edge.sourceHandle === undefined || edge.sourceHandle === null
            ? {}
            : { sourceHandle: edge.sourceHandle }),
        })),
      })),

    validate_workflow: () =>
      Effect.map(draft.current, (document) => {
        const issues = collectWorkflowIssues({
          nodes: [...document.nodes],
          catalog: draft.catalog,
          integrations: draft.integrations,
        });

        return {
          issues: issues.map((issue) => ({
            kind: issue.kind,
            severity: issue.severity,
            nodeId: issue.nodeId,
            nodeLabel: issue.nodeLabel,
            message: issue.message,
          })),
          hasBlockingIssues: hasBlockingWorkflowIssues(issues),
        };
      }),
  };
});
