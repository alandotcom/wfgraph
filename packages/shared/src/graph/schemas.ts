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
 * duplicated workflow from carrying a Lifecycle Node config field the Lifecycle
 * Node never defined. A `Schema.StructWithRest` names the same fields and then admits
 * whatever else came with them, which is what the node and edge attributes need:
 * React Flow writes its own bookkeeping onto both, and the editor round-trips
 * fields this schema has never heard of. An index signature skips the
 * excess-property check, so those stay open under the same decode options.
 *
 * Run `status` and editor `onClick` are not part of this schema. A live overlay
 * may still write `status` onto node data; `StructWithRest` admits it and
 * `graph.ts` strips it before a node becomes `PersistedNodeData`.
 */

import { Schema } from "effect";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import { listOf, NonEmptyTrimmedString, unknownRest } from "#src/types/schema";
import { lifecycleRulesSchema } from "#src/lifecycle/lifecycle-rules";
import { testPayloadsSchema } from "#src/lifecycle/test-payloads";
/**
 * What the entry node carries.
 *
 * The entry node is the Lifecycle Node: its Lifecycle Rules are the declaration
 * the engine reads to decide which Events start a run and what Concurrency does
 * to the runs already going (ADR-0007). There is no per-type arm, because the
 * Lifecycle Node carries no kind of its own: what reaches it is an Event,
 * named in the rules.
 *
 * The payload a run receives belongs to the Event that started or canceled it, so
 * the Events name its shape and the editor derives the fields it offers from
 * them. Beside the rules sit the test-run samples, which are editor data the
 * delivery path never reads.
 */
const workflowLifecycleConfigSchema = Schema.Struct({
  lifecycleRules: Schema.optional(lifecycleRulesSchema),
  testPayloads: Schema.optional(testPayloadsSchema),
}).annotate({
  message: "Lifecycle config must be an object",
});

const workflowNodeDataBaseFields = {
  label: Schema.String,
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
};

const workflowLifecycleNodeDataSchema = Schema.StructWithRest(
  Schema.Struct({
    ...workflowNodeDataBaseFields,
    type: Schema.Literal("lifecycle"),
    config: Schema.optional(workflowLifecycleConfigSchema),
  }),
  unknownRest
);

const conditionActionConfigSchema = Schema.Struct({
  actionType: Schema.Literal(BUILT_IN_ACTION_IDS.condition),
  /**
   * What the engine evaluates: a CEL string from the editor, or a literal
   * boolean used by tests and short-circuit fixtures.
   */
  condition: Schema.optional(Schema.Union([Schema.String, Schema.Boolean])),
  /** Serialized ConditionModel the editor edits. */
  conditionModel: Schema.optional(Schema.String),
  integrationId: Schema.optional(Schema.String),
}).annotate({
  message: "Condition config must be an object",
});

/**
 * Wait config on the wire beside a typed actionType.
 *
 * `waitMode` is closed here the same way `waitConfigSchema` is: `"hook"` is
 * retired, and a save that still carries it fails at the graph boundary rather
 * than parking a run that the engine would refuse. Named keys are the ones the
 * editor writes today; the rest rides through for React Flow bookkeeping.
 */
const waitActionConfigSchema = Schema.StructWithRest(
  Schema.Struct({
    actionType: Schema.Literal(BUILT_IN_ACTION_IDS.wait),
    integrationId: Schema.optional(Schema.String),
    waitDelayTimingMode: Schema.optional(Schema.String),
    waitMode: Schema.optional(Schema.Literals(["delay", "event"])),
    waitFor: Schema.optional(Schema.Unknown),
    waitTimeout: Schema.optional(Schema.String),
    waitTimeoutBehavior: Schema.optional(Schema.String),
    waitDuration: Schema.optional(Schema.String),
    waitUntil: Schema.optional(Schema.String),
    waitOffset: Schema.optional(Schema.String),
    waitGateMode: Schema.optional(Schema.String),
    waitAllowedHoursMode: Schema.optional(Schema.String),
    waitAllowedStartTime: Schema.optional(Schema.String),
    waitAllowedEndTime: Schema.optional(Schema.String),
    waitTimezone: Schema.optional(Schema.String),
  }),
  unknownRest
).annotate({
  message: "Wait config must be an object",
});

const eventSplitActionConfigSchema = Schema.Struct({
  actionType: Schema.Literal(BUILT_IN_ACTION_IDS.eventSplit),
  integrationId: Schema.optional(Schema.String),
}).annotate({
  message: "Event Split config must be an object",
});

/**
 * Plugin and host action configs: `actionType` / `integrationId` are named;
 * catalog fields stay in the rest. Built-in ids are refused here so a Condition
 * / Wait / Event Split config that fails its closed arm cannot fall through
 * into this open one.
 */
const pluginActionTypeSchema = NonEmptyTrimmedString.check(
  Schema.makeFilter((value: string) => {
    if (
      value === BUILT_IN_ACTION_IDS.condition ||
      value === BUILT_IN_ACTION_IDS.wait ||
      value === BUILT_IN_ACTION_IDS.eventSplit
    ) {
      return "Built-in action configs use their own schema arm";
    }
    return true;
  })
);

const pluginActionConfigSchema = Schema.StructWithRest(
  Schema.Struct({
    actionType: Schema.optional(pluginActionTypeSchema),
    integrationId: Schema.optional(Schema.String),
  }),
  unknownRest
);

const workflowActionConfigSchema = Schema.Union([
  conditionActionConfigSchema,
  waitActionConfigSchema,
  eventSplitActionConfigSchema,
  pluginActionConfigSchema,
]).annotate({
  message: "Action config must be an object",
});

const workflowActionNodeDataSchema = Schema.StructWithRest(
  Schema.Struct({
    ...workflowNodeDataBaseFields,
    type: Schema.Literal("action"),
    config: Schema.optional(workflowActionConfigSchema),
  }),
  unknownRest
);

const workflowAddNodeDataSchema = Schema.StructWithRest(
  Schema.Struct({
    ...workflowNodeDataBaseFields,
    type: Schema.Literal("add"),
    config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  unknownRest
);

const workflowGroupConfigSchema = Schema.Struct({
  entryNodeId: Schema.optional(NonEmptyTrimmedString),
  exitNodeId: Schema.optional(NonEmptyTrimmedString),
}).annotate({
  message: "Group config must be an object",
});

const workflowGroupNodeDataSchema = Schema.StructWithRest(
  Schema.Struct({
    ...workflowNodeDataBaseFields,
    type: Schema.Literal("group"),
    config: Schema.optional(workflowGroupConfigSchema),
  }),
  unknownRest
);

/**
 * The message is the bound on what a rejection may say.
 *
 * When `type` holds none of the four literals, Effect selects no arm at all,
 * and a union that matched nothing renders as its own expected type beside the
 * whole value it rejected -- past the leaf hook `schema-message.ts` installs,
 * which is the only other place this project bounds a message. Node data is
 * whatever the editor drew, so that value is not something to put in a run
 * error or a log line. Saying what was expected covers every input that gets
 * here, because getting here is exactly `type` not being one of the four.
 */
export const workflowNodeDataSchema = Schema.Union([
  workflowLifecycleNodeDataSchema,
  workflowActionNodeDataSchema,
  workflowAddNodeDataSchema,
  workflowGroupNodeDataSchema,
]).annotate({
  message: 'Node data needs a type of "lifecycle", "action", "add", or "group"',
});

export const workflowNodeAttributesSchema = Schema.StructWithRest(
  Schema.Struct({
    id: NonEmptyTrimmedString,
    type: Schema.optional(
      Schema.Literals(["lifecycle", "action", "add", "group"])
    ),
    parentId: Schema.optional(NonEmptyTrimmedString),
    width: Schema.optional(Schema.Finite),
    height: Schema.optional(Schema.Finite),
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

const serializedWorkflowNodeSchema = Schema.Struct({
  key: NonEmptyTrimmedString,
  attributes: workflowNodeAttributesSchema,
});

const serializedWorkflowEdgeSchema = Schema.Struct({
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
