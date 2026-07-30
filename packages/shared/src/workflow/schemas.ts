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
import { routingPolicySchema } from "#src/workflow/routing-policy";

/**
 * What the entry node carries whatever else is on it.
 *
 * The entry node is the Lifecycle Node: its Lifecycle Rules are the declaration
 * the engine reads to decide which Events start a run and what Concurrency does
 * to the runs already going (ADR-0007). The trigger fields below are the panel's
 * and nothing on an intake path reads them.
 */
const lifecycleNodeFields = {
  lifecycleRules: Schema.optional(lifecycleRulesSchema),
};

export const webhookTriggerConfigSchema = Schema.Struct({
  ...lifecycleNodeFields,
  triggerType: Schema.Literal("Webhook"),
  webhookSchema: Schema.optional(Schema.String),
  webhookOutputSchema: Schema.optional(Schema.String),
  webhookEventPath: Schema.optional(Schema.String),
  webhookCorrelationPath: Schema.optional(Schema.String),
  routingPolicy: Schema.optional(routingPolicySchema),
  webhookMockRequest: Schema.optional(Schema.String),
});

export const scheduleTriggerConfigSchema = Schema.Struct({
  ...lifecycleNodeFields,
  triggerType: Schema.Literal("Schedule"),
  scheduleExpression: Schema.optional(Schema.String),
  scheduleCron: Schema.optional(Schema.String),
  scheduleTimezone: Schema.optional(Schema.String),
});

/**
 * Every other trigger type, whose fields belong to whoever registered it.
 *
 * The check is what keeps this arm from swallowing a malformed Webhook or
 * Schedule config: without it an open object matches anything, and a webhook
 * config with a typo'd field would decode here instead of failing.
 *
 * Its `triggerType` is an open string, so unlike the two arms above it carries
 * no literal Effect can select on. A decode of a Webhook config therefore tries
 * this arm too, and a failure message mentions its refusal beside the real
 * problem.
 */
export const customTriggerConfigSchema = Schema.StructWithRest(
  Schema.Struct({
    ...lifecycleNodeFields,
    triggerType: NonEmptyTrimmedString,
    routingPolicy: Schema.optional(routingPolicySchema),
  }),
  unknownRest
).check(
  Schema.makeFilter((value) =>
    value.triggerType === "Webhook" || value.triggerType === "Schedule"
      ? 'Custom triggerType must not be "Webhook" or "Schedule"'
      : undefined
  )
);

// Annotated for the same reason as the node data union below: a config that is
// not an object matches no arm, and an unmatched union prints the value it
// rejected unless a message says otherwise.
export const workflowTriggerConfigSchema = Schema.Union([
  webhookTriggerConfigSchema,
  scheduleTriggerConfigSchema,
  customTriggerConfigSchema,
]).annotate({
  message: "Trigger config must be an object naming a triggerType",
});
// When adding a new first-class trigger type (beyond Webhook/Schedule):
// - Add a dedicated schema here and include it in this union.
// - Mirror the trigger option + config UI in `src/components/workflow/config/trigger-config.tsx`.
// Custom trigger configs are still accepted through `customTriggerConfigSchema`.

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
