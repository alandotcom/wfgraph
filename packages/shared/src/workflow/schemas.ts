/**
 * The workflow graph as it travels: the shape a graph has in the JSONB column,
 * in an RPC payload, on an Inngest event, and -- the origin that decides how
 * optional fields are spelled below -- in the editor's own process, where
 * `createSerializedWorkflowGraph` decodes what `graph.export()` built out of
 * React Flow state on the way to an autosave.
 *
 * The first three origins arrive through `JSON.parse`, which never produces a
 * key holding `undefined`. The fourth does: an object TypeScript wrote says "no
 * value" by setting the key to `undefined`, and React Flow node data is full of
 * such keys. So every optional field here is `Schema.optional` rather than
 * `Schema.optionalKey` -- the stricter spelling rejects a present-and-undefined
 * key, which on this path means the editor refusing to save what it just drew.
 *
 * Two kinds of object live here and the difference is deliberate. A
 * `Schema.Struct` is closed, and every decode in this project supplies
 * `rejectUnknownKeys`, so a stray key is an error -- that is what stops a
 * duplicated workflow from carrying a trigger config field the trigger never
 * defined. A `Schema.StructWithRest` names the same fields and then admits
 * whatever else came with them, which is what the node and edge attributes need:
 * React Flow writes its own bookkeeping onto both, and the editor round-trips
 * fields this schema has never heard of. An index signature skips the
 * excess-property check, so those stay open under the same decode options.
 */

import { Schema } from "effect";
import { listOf, NonEmptyTrimmedString, unknownRest } from "#src/types/schema";
import { lifecycleRulesSchema } from "#src/workflow/lifecycle-rules";

/**
 * What the entry node carries.
 *
 * The entry node is the Lifecycle Node: its Lifecycle Rules are the declaration
 * the engine reads to decide which Events start a run and what Concurrency does
 * to the runs already going (ADR-0007). There is no trigger type here and no
 * per-type arm, because an entry node no longer has a kind -- what reaches it is
 * an Event, named in the rules.
 *
 * The three schema fields describe the payload a run receives: the shape, the
 * narrowing of it downstream nodes read, and a sample to try a run against. B5
 * replaces them with the Start Events' own `payloadFields`, which is where that
 * shape belongs, and this closed struct is what makes the swap a compile error
 * rather than a field nobody removed.
 */
export const workflowTriggerConfigSchema = Schema.Struct({
  lifecycleRules: Schema.optional(lifecycleRulesSchema),
  webhookSchema: Schema.optional(Schema.String),
  webhookOutputSchema: Schema.optional(Schema.String),
  webhookMockRequest: Schema.optional(Schema.String),
}).annotate({
  message: "Trigger config must be an object",
});

const workflowNodeDataBaseFields = {
  label: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.Literals(["idle", "running", "success", "error", "cancelled"])
  ),
  enabled: Schema.optional(Schema.Boolean),
};

const workflowTriggerNodeDataSchema = Schema.StructWithRest(
  Schema.Struct({
    ...workflowNodeDataBaseFields,
    type: Schema.Literal("trigger"),
    config: Schema.optional(workflowTriggerConfigSchema),
  }),
  unknownRest
);

/**
 * The two node kinds whose config is an open bag, one arm each.
 *
 * A single arm declaring `Schema.Literals(["action", "add"])` would describe
 * the same values, and would cost every failure message. Effect narrows a union
 * to the arms whose literal-valued fields match the input, and a field holding
 * a union of literals is not one of those: the arm would be tried against every
 * node, so a trigger node with a bad config would be told about `"action" |
 * "add"` as well. One literal per arm is what makes the selection engage.
 */
function nodeDataWithConfigBag<Type extends string>(type: Type) {
  return Schema.StructWithRest(
    Schema.Struct({
      ...workflowNodeDataBaseFields,
      type: Schema.Literal(type),
      config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    unknownRest
  );
}

/**
 * The message is the bound on what a rejection may say.
 *
 * When `type` holds none of the three literals, Effect selects no arm at all,
 * and a union that matched nothing renders as its own expected type beside the
 * whole value it rejected -- past the leaf hook `schema-message.ts` installs,
 * which is the only other place this project bounds a message. Node data is
 * whatever the editor drew, so that value is not something to put in a run
 * error or a log line. Saying what was expected covers every input that gets
 * here, because getting here is exactly `type` not being one of the three.
 */
export const workflowNodeDataSchema = Schema.Union([
  workflowTriggerNodeDataSchema,
  nodeDataWithConfigBag("action"),
  nodeDataWithConfigBag("add"),
]).annotate({
  message: 'Node data needs a type of "trigger", "action", or "add"',
});

export const workflowNodeAttributesSchema = Schema.StructWithRest(
  Schema.Struct({
    id: NonEmptyTrimmedString,
    type: Schema.optional(Schema.String),
    // `Schema.Finite` rejects Infinity and NaN. A node position holding either
    // is already corruption, and the editor's save store treats a rejected
    // graph as "nothing to save" rather than surfacing it.
    position: Schema.optional(
      Schema.Struct({
        x: Schema.Finite,
        y: Schema.Finite,
      })
    ),
    data: workflowNodeDataSchema,
  }),
  unknownRest
);

export const workflowEdgeAttributesSchema = Schema.StructWithRest(
  Schema.Struct({
    id: NonEmptyTrimmedString,
    source: NonEmptyTrimmedString,
    target: NonEmptyTrimmedString,
    sourceHandle: Schema.optional(Schema.NullOr(NonEmptyTrimmedString)),
    targetHandle: Schema.optional(Schema.NullOr(NonEmptyTrimmedString)),
    data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  unknownRest
);

export const serializedWorkflowNodeSchema = Schema.Struct({
  key: NonEmptyTrimmedString,
  attributes: workflowNodeAttributesSchema,
});

export const serializedWorkflowEdgeSchema = Schema.Struct({
  key: NonEmptyTrimmedString,
  source: NonEmptyTrimmedString,
  target: NonEmptyTrimmedString,
  attributes: workflowEdgeAttributesSchema,
  undirected: Schema.optional(Schema.Literal(false)),
});

export const serializedWorkflowGraphSchema = Schema.Struct({
  attributes: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  options: Schema.optional(
    Schema.Struct({
      allowSelfLoops: Schema.optional(Schema.Boolean),
      multi: Schema.optional(Schema.Boolean),
      type: Schema.optional(
        Schema.Literals(["directed", "undirected", "mixed"])
      ),
    })
  ),
  // Mutable, because graphology hands a graph to `import` as something it may
  // rearrange, and the editor builds these arrays before handing them over.
  nodes: listOf(serializedWorkflowNodeSchema),
  edges: listOf(serializedWorkflowEdgeSchema),
});

export type SerializedWorkflowGraphInput =
  typeof serializedWorkflowGraphSchema.Type;
