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

import { Array as Arr, Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import {
  entityStateConditionPath,
  type ConditionFieldType,
} from "@wfgraph/shared/conditions/condition-model";
import { conditionTypeOf } from "@wfgraph/shared/conditions/condition-field-type";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  type ArrivingEventReachability,
  arrivingEventReachability,
} from "@wfgraph/shared/graph/events-reaching";
import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import {
  ENTITY_STATE_SOURCE_ID,
  fieldsVisibleForConfig,
  formatTemplateToken,
  referenceFieldLabel,
  type ReferenceField,
} from "@wfgraph/shared/graph/node-references";
import { reachableEventFields } from "@wfgraph/shared/graph/reachable-fields";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import { findTrackedEntityStateSource } from "@wfgraph/shared/lifecycle/entity-eligibility";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { upstreamNodeIds } from "@wfgraph/shared/graph/upstream-nodes";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { type AgentDocument, WorkflowDraft } from "#src/document";
import {
  pageResults,
  resultLimitSchema,
  resultOffsetSchema,
} from "#src/tools/result-page";
import { readHints } from "#src/tools/tool-hints";

const referenceSchema = Schema.Struct({
  /** Paste this straight into a config field. */
  token: Schema.String,
  sourceNodeId: Schema.String,
  sourceNodeLabel: Schema.String,
  path: Schema.String,
  label: Schema.String,
  type: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** True when a run may reach this node without the value being set. */
  nullable: Schema.optionalKey(Schema.Boolean),
  /**
   * On a Lifecycle Node reference, the Events this path comes from. Below an
   * event-mode Wait these are the Events that Wait parks on, not the Start
   * Events, because the Wait decides the Arriving Event for everything under it.
   */
  declaredBy: Schema.optionalKey(Schema.Array(Schema.String)),
  enumValues: Schema.optionalKey(Schema.Array(Schema.String)),
  enumLabels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Pass this exact value to set_condition; absence means the field cannot be tested. */
  conditionFieldType: Schema.optionalKey(
    Schema.Literals(["string", "number", "boolean", "timestamp"])
  ),
  /** True when a condition must provide a recordKey under this path. */
  openRecord: Schema.optionalKey(Schema.Boolean),
  /**
   * The named steps that can read this value, present only when some of the
   * steps the call named cannot, or read it differently.
   */
  readableBy: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** The most steps one `list_references` call may name. */
export const MAX_REFERENCE_NODES = 25;

/**
 * A field one upstream node offers, with the Events behind it where there are
 * any. An action's own output fields name no Event, so `declaredBy` is absent
 * on those and present on every Lifecycle Node field.
 */
type AgentReferenceField = ReferenceField & {
  readonly declaredBy?: readonly string[] | undefined;
};

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
  readonly eventReachability: ArrivingEventReachability;
  readonly catalog: ExtensionCatalog;
}): readonly AgentReferenceField[] {
  const actionType = readConfigString(input.node.data.config, "actionType");
  if (actionType) {
    const action = findAction(input.catalog, actionType);
    return action
      ? fieldsVisibleForConfig(input.node.data.config, action.outputFields)
      : [];
  }

  if (input.node.data.type === "lifecycle") {
    const fields = reachableEventFields(input.eventReachability.events);

    // A run that leaves an event-mode Wait on its timeout carries no Arriving
    // Event, and the entry node's payload is empty for the rest of that run. So
    // every path here is one a run can reach this node without.
    return input.eventReachability.eventCanBeAbsent
      ? fields.map((field) => ({ ...field, nullable: true }))
      : fields;
  }

  // An action type the catalog no longer ships declares no schema, so there is
  // nothing addressable to offer.
  return [];
}

export const ListReferences = Tool.make("list_references", {
  description:
    "Every value the named nodes' configs may refer to, each as a finished {{@nodeId:Label.path}} token. Name every step you are about to configure in one call. A reference with no readableBy is readable by every node you named; one with readableBy is readable only by the nodes it lists. Only nodes above a node in the graph can be referenced, so connect a node before asking what it can read. A tracked Entity is also available through the virtual $entity source, even without Entity Eligibility; use its token in text config and its path in set_condition. The Lifecycle Node offers the payload of the Arriving Event, which an event-mode Wait above a node replaces with the Events that Wait parks on: read declaredBy to see which Events a path came from, and expect the Start Event payload to be unavailable below such a Wait. Re-read this list after configuring any Wait above a node, because that edit changes what is addressable there.",
  parameters: Schema.Struct({
    nodeIds: Schema.Array(Schema.String).annotate({
      description: `The nodes whose configs are being filled in, at most ${MAX_REFERENCE_NODES}.`,
    }),
    query: Schema.optionalKey(Schema.String).annotate({
      description:
        "Case-insensitive text matched against the source node, field label, path, type, description, and token.",
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
}).annotateMerge(readHints("List references"));

/** Every addressable reference, including hidden fields kept for compatibility. */
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
  const eventReachability = arrivingEventReachability({
    targetNodeId: input.nodeId,
    nodes: input.document.nodes,
    edges: input.document.edges,
    catalog: input.catalog,
  });

  const upstreamReferences = input.document.nodes
    .filter((node) => upstream.has(node.id))
    .flatMap((node) => {
      const sourceNodeLabel = getNodeDisplayName(input.catalog, node);

      return outputFieldsOf({
        node,
        eventReachability,
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
          label: referenceFieldLabel(field),
          type: field.type,
          description: field.description,
          nullable: field.nullable,
          declaredBy: field.declaredBy ? [...field.declaredBy] : undefined,
          enumValues: field.enumValues,
          enumLabels: field.enumLabels,
          conditionFieldType: conditionFieldType ?? undefined,
          openRecord: field.valueType ? true : undefined,
          hidden: field.hidden,
        });
      });
    });

  const lifecycle = input.document.nodes.find(
    (node) => node.data.type === "lifecycle"
  );
  const entity = findTrackedEntityStateSource({
    rules: readLifecycleRules(lifecycle?.data.config),
    catalog: input.catalog,
  });
  const entityReferences = entity
    ? entity.stateFields.flatMap((field) => {
        const path = entityStateConditionPath(entity.type, field.path);
        if (!path) {
          return [];
        }
        const conditionFieldType = conditionFieldTypeOf(field);
        return [
          omitUndefined({
            token: formatTemplateToken({
              nodeId: ENTITY_STATE_SOURCE_ID,
              nodeLabel: entity.label,
              sourceType: entity.type,
              fieldPath: field.path,
            }),
            sourceNodeId: ENTITY_STATE_SOURCE_ID,
            sourceNodeLabel: entity.label,
            path,
            label: referenceFieldLabel(field),
            type: field.type,
            description: field.description,
            nullable: field.nullable,
            enumValues: field.enumValues,
            enumLabels: field.enumLabels,
            conditionFieldType: conditionFieldType ?? undefined,
            openRecord: field.valueType ? true : undefined,
            hidden: field.hidden,
          }),
        ];
      })
    : [];

  return [...upstreamReferences, ...entityReferences];
}

type NodeReference = NonNullable<ReturnType<typeof referencesForNode>>[number];

/**
 * The references of several nodes as one list, in first-seen order. A value
 * two nodes read identically appears once. `readableBy` names the nodes that
 * read an entry, and is left off an entry every named node reads, so the
 * common case of a shared upstream costs no extra text.
 */
function mergeReferences(
  perNode: readonly {
    readonly nodeId: string;
    readonly references: readonly NodeReference[];
  }[]
): (NodeReference & { readonly readableBy?: readonly string[] })[] {
  // Keyed by the whole entry: the same token can be nullable for one node and
  // not for another, or come from different Events, and those stay apart.
  const merged = new Map<
    string,
    { reference: NodeReference; readableBy: string[] }
  >();
  for (const { nodeId, references } of perNode) {
    for (const reference of references) {
      const key = JSON.stringify(reference);
      const entry = merged.get(key);
      if (entry) {
        entry.readableBy.push(nodeId);
      } else {
        merged.set(key, { reference, readableBy: [nodeId] });
      }
    }
  }
  return [...merged.values()].map(({ reference, readableBy }) =>
    readableBy.length === perNode.length
      ? reference
      : { ...reference, readableBy }
  );
}

export const referenceToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    list_references: (input: {
      readonly nodeIds: readonly string[];
      readonly query?: string | undefined;
      readonly sourceNodeId?: string | undefined;
      readonly type?: string | undefined;
      readonly offset?: number | undefined;
      readonly limit?: number | undefined;
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const nodeIds = Arr.dedupe(input.nodeIds);
        if (nodeIds.length === 0) {
          return Effect.fail({
            reason: "list_references needs at least one node id in nodeIds.",
          });
        }
        if (nodeIds.length > MAX_REFERENCE_NODES) {
          return Effect.fail({
            reason: `list_references takes at most ${MAX_REFERENCE_NODES} node ids; split the call.`,
          });
        }
        const perNode = nodeIds.map((nodeId) => ({
          nodeId,
          references: referencesForNode({
            nodeId,
            document,
            catalog: draft.catalog,
          }),
        }));
        const missing = perNode
          .filter((entry) => entry.references === undefined)
          .map((entry) => entry.nodeId);
        if (missing.length > 0) {
          return Effect.fail({
            reason: `No node with id ${missing.join(", ")}. Call read_workflow to see what the graph holds.`,
          });
        }
        const references = mergeReferences(
          perNode.map((entry) => ({
            nodeId: entry.nodeId,
            references: entry.references ?? [],
          }))
        );

        const needle = input.query?.trim().toLowerCase() ?? "";
        const matches = references.filter(
          (reference) =>
            reference.hidden !== true &&
            (input.sourceNodeId === undefined ||
              reference.sourceNodeId === input.sourceNodeId) &&
            (input.type === undefined || reference.type === input.type) &&
            (needle.length === 0 ||
              [
                reference.token,
                reference.sourceNodeLabel,
                reference.path,
                reference.label ?? "",
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
