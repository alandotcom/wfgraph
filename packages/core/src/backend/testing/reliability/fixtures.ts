import { Schema } from "effect";
import { defineAction } from "#src/backend/extensions/define-action";
import { defineEntity } from "#src/backend/extensions/define-entity";
import { defineEvent } from "#src/backend/extensions/define-event";
import { toStandardSchema } from "@wfgraph/shared/types/schema";
import type { JsonObject } from "@wfgraph/shared/types/json";
import {
  compileConditionModel,
  type ConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";

export const START = "reliability/start";
export const CANCEL = "reliability/cancel";
export const WAKE = [
  "reliability/wake0",
  "reliability/wake1",
  "reliability/wake2",
];
export function fixtureExtensions() {
  const ledger: Array<{ marker: string }> = [];
  const state = { active: true, missing: false, unavailable: false };
  const entity = defineEntity({
    type: "subject",
    label: "Subject",
    state: toStandardSchema(Schema.Struct({ active: Schema.Boolean })),
    resolve: () => {
      if (state.unavailable) throw new Error("Entity resolver unavailable");
      return state.missing ? null : { active: state.active };
    },
  });
  const eventSchema = toStandardSchema(
    Schema.Struct({ entityId: Schema.String, marker: Schema.String })
  );
  const events = [START, CANCEL, ...WAKE].map((name) =>
    defineEvent({
      name,
      label: name,
      schema: eventSchema,
      correlationPath: "entityId",
      entities: {
        subject: { entity, selectEntityId: (event) => event.entityId },
      },
    })
  );
  const action = defineAction({
    id: "reliability/record",
    label: "Record",
    description: "Record an observed effect",
    category: "Test",
    input: toStandardSchema(Schema.Struct({ marker: Schema.String })),
    output: toStandardSchema(Schema.Struct({ marker: Schema.String })),
    handler: ({ input, step }) =>
      step.run("record", () => {
        ledger.push({ marker: input.marker });
        return Promise.resolve({ marker: input.marker });
      }),
  });
  return { ledger, state, extensions: { events, actions: [action] } };
}
/** A node in the serialized graph shape the workflow RPC accepts. */
export type FixtureNode = {
  key: string;
  attributes: {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: { id: string; type: string; label: string; config: JsonObject };
    /** The id of the Group frame that holds this step. */
    parentId?: string;
  };
};
export type FixtureEdge = ReturnType<typeof edge>;
export type FixtureGraph = { nodes: FixtureNode[]; edges: FixtureEdge[] };

export const node = (
  id: string,
  type: string,
  config: JsonObject
): FixtureNode => ({
  key: id,
  attributes: {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { id, type, label: id, config },
  },
});
export const edge = (
  source: string,
  target: string,
  sourceHandle: string | null = null
) => ({
  key: `${source}_${target}`,
  source,
  target,
  attributes: {
    id: `${source}_${target}`,
    source,
    target,
    sourceHandle,
    targetHandle: null,
  },
});
export const record = (id: string, marker = id) =>
  node(id, "action", { actionType: "reliability/record", marker });
export const wait = (
  id: string,
  mode: "event" | "delay",
  event = WAKE[0],
  duration = "10m"
) =>
  node(
    id,
    "action",
    mode === "event"
      ? {
          actionType: "Wait",
          waitMode: mode,
          waitFor: [{ event }],
          waitTimeout: "10m",
          waitTimeoutBehavior: "skip",
        }
      : {
          actionType: "Wait",
          waitMode: mode,
          waitDuration: duration,
          waitGateMode: "require_actual_wait",
        }
  );
/**
 * A Condition that takes its `true` outlet when the payload's `marker` equals
 * `marker`. Publish requires the expression to be the one compiled from the
 * structured model, so both are stored.
 */
export function condition(id: string, marker: string) {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          {
            id: "marker",
            field: "marker",
            fieldType: "string",
            operator: "equals",
            value: marker,
          },
        ],
      },
    ],
  };
  const compiled = compileConditionModel(model);
  if (!compiled.valid) throw new Error(compiled.error);
  return node(id, "action", {
    actionType: "Condition",
    condition: compiled.expression,
    conditionModel: serializeConditionModel(model),
  });
}
export function lifecycle(checkpoints: string[]) {
  return node("entry", "lifecycle", {
    lifecycleRules: {
      startEvents: [START],
      cancelEvents: [CANCEL],
      concurrency: "unlimited",
      allowManualStart: false,
      trackedEntity: {
        type: "subject",
        bindings: { [START]: "subject", [CANCEL]: "subject" },
      },
      entityEligibility: {
        checkpoints,
        condition: JSON.stringify({
          version: 2,
          groupLogic: "and",
          groups: [
            {
              id: "group",
              logic: "and",
              conditions: [
                {
                  id: "active",
                  field: "active",
                  fieldType: "boolean",
                  operator: "is_true",
                },
              ],
            },
          ],
        }),
      },
    },
  });
}
export const admissionGraph = (marker: string) => ({
  nodes: [lifecycle(["before-execution"]), record("work", marker)],
  edges: [edge("entry", "work", "started")],
});

/** A replacement publication that no longer accepts Start events. */
export function admissionGraphWithoutStart(marker: string) {
  const graph = admissionGraph(marker);
  graph.nodes[0] = node("entry", "lifecycle", {
    lifecycleRules: {
      startEvents: [],
      cancelEvents: [],
      concurrency: "unlimited",
      allowManualStart: true,
    },
  });
  return graph;
}
