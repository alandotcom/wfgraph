/**
 * The tool that answers "what can this node's config refer to".
 *
 * A config field holds a template token, `{{@nodeId:Label.path}}`, and the
 * engine resolves it by the id. Getting one wrong is the most common way an
 * otherwise correct workflow fails at run time, so this tool hands the model the
 * finished token rather than the parts to assemble it from.
 *
 * What a node can address is decided by the graph above it: an action node
 * offers the output fields its catalog entry declares, and the Lifecycle Node
 * offers the payload of whichever Events could have put a run there. Both
 * answers come from `@wfgraph/shared`, which is also where the editor's
 * reference picker reads them.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type { ConditionFieldType } from "@wfgraph/shared/conditions/condition-model";
import { conditionTypeOf } from "@wfgraph/shared/conditions/condition-field-type";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { eventsReaching } from "@wfgraph/shared/graph/events-reaching";
import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import {
  fieldsVisibleForConfig,
  formatTemplateToken,
  type ReferenceField,
} from "@wfgraph/shared/graph/node-references";
import { reachableEventFields } from "@wfgraph/shared/graph/reachable-fields";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import { upstreamNodeIds } from "@wfgraph/shared/graph/upstream-nodes";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { type AgentDocument, WorkflowDraft } from "#src/document";
import {
  pageResults,
  resultLimitSchema,
  resultOffsetSchema,
} from "#src/tools/result-page";

const referenceSchema = Schema.Struct({
  /** Paste this straight into a config field. */
  token: Schema.String,
  sourceNodeId: Schema.String,
  sourceNodeLabel: Schema.String,
  path: Schema.String,
  type: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** True when a run may reach this node without the value being set. */
  nullable: Schema.optionalKey(Schema.Boolean),
  enumValues: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Pass this exact value to set_condition; absence means the field cannot be tested. */
  conditionFieldType: Schema.optionalKey(
    Schema.Literals(["string", "number", "boolean", "timestamp"])
  ),
  /** True when a condition must provide a recordKey under this path. */
  openRecord: Schema.optionalKey(Schema.Boolean),
});

/** The condition type a reference supports, absent for objects and type clashes. */
function conditionFieldTypeOf(
  field: ReferenceField
): ConditionFieldType | null {
  if ("typeClash" in field && field.typeClash) {
    return null;
  }
  return conditionTypeOf(field);
}

/**
 * The fields one upstream node offers.
 *
 * An action reads its declared outputs, narrowed to the ones its own config
 * leaves visible. The Lifecycle Node reads the Events that could have started
 * the run that arrives here, which is why the target node is part of the
 * question rather than only the source.
 */
function outputFieldsOf(input: {
  readonly node: WorkflowNode;
  readonly targetNodeId: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly catalog: ExtensionCatalog;
}): readonly ReferenceField[] {
  const actionType = readConfigString(input.node.data.config, "actionType");
  if (actionType) {
    const action = findAction(input.catalog, actionType);
    return action
      ? fieldsVisibleForConfig(input.node.data.config, action.outputFields)
      : [];
  }

  if (input.node.data.type === "lifecycle") {
    return reachableEventFields(
      eventsReaching({
        targetNodeId: input.targetNodeId,
        nodes: input.nodes,
        edges: input.edges,
        catalog: input.catalog,
      })
    );
  }

  // An action type the catalog no longer ships declares no schema, so there is
  // nothing addressable to offer.
  return [];
}

export const ListReferences = Tool.make("list_references", {
  description:
    "Every value a given node's config may refer to, each as a finished {{@nodeId:Label.path}} token. Only nodes above this one in the graph can be referenced, so connect a node before filling in a config that reads from upstream.",
  parameters: Schema.Struct({
    nodeId: Schema.String.annotate({
      description: "The node whose config is being filled in.",
    }),
    query: Schema.optionalKey(Schema.String).annotate({
      description:
        "Case-insensitive text matched against the source node, path, type, description, and token.",
    }),
    sourceNodeId: Schema.optionalKey(Schema.String).annotate({
      description: "Return references from this exact upstream node only.",
    }),
    type: Schema.optionalKey(Schema.String).annotate({
      description: "Return references with this exact declared type only.",
    }),
    offset: Schema.optionalKey(resultOffsetSchema),
    limit: Schema.optionalKey(resultLimitSchema),
  }),
  success: Schema.Struct({
    references: Schema.Array(referenceSchema),
    totalMatches: Schema.Number,
    truncated: Schema.Boolean,
    nextOffset: Schema.optionalKey(Schema.Number),
  }),
  failure: Schema.Struct({ reason: Schema.String }),
  failureMode: "return",
});

/** The same reference entries the tool returns, for write tools that validate one. */
export function referencesForNode(input: {
  readonly nodeId: string;
  readonly document: AgentDocument;
  readonly catalog: ExtensionCatalog;
}) {
  const target = input.document.nodes.find((node) => node.id === input.nodeId);
  if (!target) {
    return undefined;
  }

  const upstream = upstreamNodeIds(input.nodeId, input.document.edges);
  return input.document.nodes
    .filter((node) => upstream.has(node.id))
    .flatMap((node) => {
      const sourceNodeLabel = getNodeDisplayName(input.catalog, node);

      return outputFieldsOf({
        node,
        targetNodeId: input.nodeId,
        nodes: input.document.nodes,
        edges: input.document.edges,
        catalog: input.catalog,
      }).map((field) => {
        const conditionFieldType = conditionFieldTypeOf(field);
        return omitUndefined({
          token: formatTemplateToken({
            nodeId: node.id,
            nodeLabel: sourceNodeLabel,
            fieldPath: field.path,
          }),
          sourceNodeId: node.id,
          sourceNodeLabel,
          path: field.path,
          type: field.type,
          description: field.description,
          nullable: field.nullable,
          enumValues: field.enumValues,
          conditionFieldType: conditionFieldType ?? undefined,
          openRecord: field.valueType ? true : undefined,
        });
      });
    });
}

export const referenceToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    list_references: (input: {
      readonly nodeId: string;
      readonly query?: string | undefined;
      readonly sourceNodeId?: string | undefined;
      readonly type?: string | undefined;
      readonly offset?: number | undefined;
      readonly limit?: number | undefined;
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const references = referencesForNode({
          nodeId: input.nodeId,
          document,
          catalog: draft.catalog,
        });
        if (!references) {
          return Effect.fail({
            reason: `No node with id ${input.nodeId}. Call read_workflow to see what the graph holds.`,
          });
        }

        const needle = input.query?.trim().toLowerCase() ?? "";
        const matches = references.filter(
          (reference) =>
            (input.sourceNodeId === undefined ||
              reference.sourceNodeId === input.sourceNodeId) &&
            (input.type === undefined || reference.type === input.type) &&
            (needle.length === 0 ||
              [
                reference.token,
                reference.sourceNodeLabel,
                reference.path,
                reference.type ?? "",
                reference.description ?? "",
              ].some((value) => value.toLowerCase().includes(needle)))
        );
        const page = pageResults(matches, input);
        return Effect.succeed(
          omitUndefined({
            references: page.items,
            totalMatches: page.total,
            truncated: page.nextOffset !== undefined,
            nextOffset: page.nextOffset,
          })
        );
      }),
  };
});
