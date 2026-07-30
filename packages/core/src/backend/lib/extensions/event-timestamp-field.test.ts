/**
 * An Event's datetime field, from the schema an author writes to the branch a run
 * takes.
 *
 * Every link in the chain has its own cases elsewhere. This one holds the chain
 * together, because each link used to work while the whole did not: a payload's
 * ISO string was offered as text, so the condition builder gave it string
 * operators and the field asking for a moment in time never listed it at all.
 */

import { Effect, Schema } from "effect";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { defineEvent } from "#src/backend/lib/extensions/define-event";
import {
  clearExtensions,
  configureExtensions,
} from "#src/backend/lib/extensions/current";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { createAction } from "@rova/shared/workflow/action-registry";
import { dateField, timestampField } from "@rova/shared/types/timestamp";
import {
  compileConditionModel,
  type ConditionModel,
  createDefaultConditionRule,
  serializeConditionModel,
  TIMESTAMP_OPERATOR_OPTIONS,
} from "@rova/shared/workflow/conditions";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import type { WorkflowNode } from "@rova/shared/workflow/types";
import { executeWorkflow } from "#src/backend/lib/workflow-engine/core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/lib/workflow-engine/recording-store";

// A step logs its own run rows through step-handler, which is not behind the store
// port; this stub keeps that path off a database.
vi.mock("#src/backend/lib/workflow-logging", () => ({
  logStepStartDb: () =>
    Promise.resolve({ logId: "mock-log-id", startTime: Date.now() }),
  logStepCompleteDb: () => Promise.resolve(),
  logWorkflowCompleteDb: () => Promise.resolve(),
}));

/**
 * A node that answers with the config it was handed, which is how a case reads
 * what template resolution produced.
 */
const ECHO_ACTION_ID = "test/echo-config";

const echoAction = createAction({
  id: ECHO_ACTION_ID,
  label: "Echo Config",
  description: "Answers with the value its config resolved to",
  schema: Schema.Struct({
    startsAt: Schema.String.annotate({ description: "The value handed in" }),
  }),
  outputSchema: Schema.Struct({
    startsAt: Schema.String.annotate({ description: "The value handed in" }),
  }),
  execute: ({ payload: handed }) => ({
    success: true,
    data: { startsAt: handed.startsAt },
  }),
});

// The engine reads the assembled surface for an action's step, and `getExtensions`
// throws outside an app rather than answering nothing, so the host action these
// cases run reaches the engine the way a host's would.
beforeAll(() => {
  configureExtensions(assembleExtensions({ actions: [echoAction] }));
});

afterAll(() => {
  clearExtensions();
});

const appointmentBooked = defineEvent({
  name: "app/appointment.booked",
  label: "Appointment booked",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String.annotate({ description: "Appointment ID" }),
      // The two spellings an author may reach for: a `Date` in a handler, and a
      // string on both sides. Either way the wire form is an ISO string.
      startsAt: dateField("When the appointment starts"),
    }).annotate({ description: "The appointment" }),
    occurredAt: timestampField("When the event was raised"),
  }),
  correlationPath: "appointment.id",
});

function conditionNode(input: {
  id: string;
  field: string;
  operator: "before" | "after";
  dateTime: string;
}): WorkflowNode {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group_1",
        logic: "and",
        conditions: [
          {
            id: "rule_1",
            field: input.field,
            fieldType: "timestamp",
            operator: input.operator,
            dateTime: input.dateTime,
          },
        ],
      },
    ],
  };

  // Saving a workflow refuses a Condition node whose expression is not what its
  // model compiles to, so the two are built together here as well.
  const compiled = compileConditionModel(model);
  if (!compiled.valid) {
    throw new Error(compiled.error);
  }

  return {
    id: input.id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: input.id,
      type: "action",
      config: {
        actionType: "Condition",
        condition: compiled.expression,
        conditionModel: serializeConditionModel(model),
      },
    },
  };
}

function graphFor(input: { operator: "before" | "after"; dateTime: string }) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "trigger_1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { label: "Trigger", type: "trigger", config: {} },
      },
      conditionNode({
        id: "condition_node",
        field: "appointment.startsAt",
        operator: input.operator,
        dateTime: input.dateTime,
      }),
      {
        id: "true_node",
        type: "action",
        position: { x: 200, y: 0 },
        data: {
          label: "true_node",
          type: "action",
          config: { actionType: "Condition", condition: true },
        },
      },
      {
        id: "echo_node",
        type: "action",
        position: { x: 400, y: 0 },
        data: {
          label: "echo_node",
          type: "action",
          config: {
            actionType: ECHO_ACTION_ID,
            startsAt: "{{@trigger_1:Trigger.appointment.startsAt}}",
          },
        },
      },
      {
        id: "false_node",
        type: "action",
        position: { x: 200, y: 100 },
        data: {
          label: "false_node",
          type: "action",
          config: { actionType: "Condition", condition: true },
        },
      },
    ],
    edges: [
      { id: "edge_t_c", source: "trigger_1", target: "condition_node" },
      {
        id: "edge_c_true",
        source: "condition_node",
        target: "true_node",
        sourceHandle: "true",
      },
      {
        id: "edge_c_false",
        source: "condition_node",
        target: "false_node",
        sourceHandle: "false",
      },
      {
        id: "edge_true_echo",
        source: "true_node",
        target: "echo_node",
        sourceHandle: "true",
      },
    ],
  });
}

/**
 * A new object per call. The engine hands the entry node's payload downstream by
 * reference, so a case comparing against a shared constant would compare two
 * objects the same run had mutated together.
 */
function bookedPayload() {
  return {
    appointment: {
      id: "appt_1",
      startsAt: "2026-03-10T09:00:00-05:00",
    },
    occurredAt: "2026-03-01T12:00:00Z",
  };
}

/** What the intake gate says about a payload, or an empty string when it passes. */
function gateRejection(payload: unknown): string {
  return Effect.runSync(
    appointmentBooked.decodePayload(payload).pipe(
      Effect.as(""),
      Effect.catchTag("PayloadRejected", (failure) =>
        Effect.succeed(failure.error)
      )
    )
  );
}

describe("an Event's datetime field, end to end", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("is offered to the editor as a timestamp, nested field included", () => {
    expect(appointmentBooked.payloadFields).toEqual(
      expect.arrayContaining([
        {
          path: "appointment.startsAt",
          description: "When the appointment starts",
          type: "timestamp",
          format: "timestamp",
        },
        {
          path: "occurredAt",
          description: "When the event was raised",
          type: "timestamp",
          format: "timestamp",
        },
      ])
    );
  });

  it("addresses a dateField by its path on the wire", () => {
    // This compiles only because a definition's paths address the payload as it
    // arrives: `startsAt` is a string there and a `Date` only after a decode,
    // and a Correlation Path is a path to a string.
    const keyedOnStart = defineEvent({
      name: "app/appointment.booked.by-time",
      label: "Appointment booked, keyed on its time",
      schema: Schema.Struct({
        startsAt: dateField("When the appointment starts"),
      }),
      correlationPath: "startsAt",
    });

    expect(keyedOnStart.correlationPath).toBe("startsAt");
  });

  it("gets the timestamp vocabulary in the condition builder", () => {
    const field = appointmentBooked.payloadFields.find(
      (candidate) => candidate.path === "appointment.startsAt"
    );

    // The builder reads a field's type to decide which operators a row offers, so
    // the type derived above is what puts before and after on this field's menu.
    expect(field?.type).toBe("timestamp");
    expect(TIMESTAMP_OPERATOR_OPTIONS.map((option) => option.value)).toEqual(
      expect.arrayContaining(["before", "after"])
    );
    expect(
      createDefaultConditionRule({
        path: "appointment.startsAt",
        label: "appointment.startsAt",
        type: "timestamp",
      }).fieldType
    ).toBe("timestamp");
  });

  it("routes a run on a before comparison against the payload's ISO string", async () => {
    const result = await executeWorkflow(
      {
        graph: graphFor({
          operator: "before",
          dateTime: "2026-03-11T00:00:00Z",
        }),
        executionId: "exec_before_true",
        workflowId: "workflow_event_timestamp",
        triggerInput: bookedPayload(),
      },
      undefined,
      store
    );

    // JSON carries no date type, and CEL compares a Timestamp to a Timestamp, so
    // the run only reaches the true branch if the ISO string became a `Date`
    // before the expression ran.
    expect(result.results.condition_node?.success).toBe(true);
    expect(result.results.true_node?.success).toBe(true);
    expect(result.results.false_node).toBeUndefined();
  });

  it("routes the other way when the moment falls on the other side", async () => {
    const result = await executeWorkflow(
      {
        graph: graphFor({
          operator: "after",
          dateTime: "2026-03-11T00:00:00Z",
        }),
        executionId: "exec_after_false",
        workflowId: "workflow_event_timestamp",
        triggerInput: bookedPayload(),
      },
      undefined,
      store
    );

    expect(result.results.true_node).toBeUndefined();
    expect(result.results.false_node?.success).toBe(true);
  });

  it("hands downstream nodes the payload and nothing else", async () => {
    // The entry node's output is the payload. A key the engine wrote here would
    // shadow a payload field of the same name, which is what `timestamp` did.
    const result = await executeWorkflow(
      {
        graph: graphFor({
          operator: "before",
          dateTime: "2026-03-11T00:00:00Z",
        }),
        executionId: "exec_entry_output",
        workflowId: "workflow_event_timestamp",
        triggerInput: bookedPayload(),
      },
      undefined,
      store
    );

    expect(result.results.trigger_1?.data).toEqual(bookedPayload());
  });

  it("leaves the payload a Condition read as the text the sender wrote", async () => {
    // A Condition evaluates over a private copy. Its context holds `Date`s where
    // the rules named timestamps, and the payload downstream has to keep the
    // sender's own string: the offset intact, and no `Date` for a template to
    // render as a JSON-quoted UTC instant that no timestamp parser accepts.
    const result = await executeWorkflow(
      {
        graph: graphFor({
          operator: "before",
          dateTime: "2026-03-11T00:00:00Z",
        }),
        executionId: "exec_downstream_template",
        workflowId: "workflow_event_timestamp",
        triggerInput: bookedPayload(),
      },
      undefined,
      store
    );

    expect(result.results.echo_node?.data).toEqual({
      success: true,
      data: { startsAt: "2026-03-10T09:00:00-05:00" },
    });
    expect(result.results.trigger_1?.data).toEqual(bookedPayload());
  });

  it("refuses a payload whose timestamp field carries no zone", () => {
    // The gate is the Event's schema, and `timestampField` requires a zone: a
    // string without one names a different instant on every machine that reads it.
    // The message names the path and quotes no value, because it is persisted as a
    // run error and answered over HTTP.
    const error = gateRejection({
      appointment: { id: "appt_1", startsAt: "2026-03-10T09:00:00" },
      occurredAt: "2026-03-01T12:00:00Z",
    });

    expect(error).toContain("appointment.startsAt");
    expect(error).not.toContain("2026-03-10T09:00:00");
  });

  it("refuses a payload whose timestamp field is padded", () => {
    // `decodeIsoTimestamp` trims before it reads, because a stored wait target is
    // read back by whichever worker resumes the run. A payload is held to the
    // pattern itself, so padding is drift on a declared field and fails at intake.
    expect(
      gateRejection({
        appointment: { id: "appt_1", startsAt: " 2026-03-10T09:00:00-05:00 " },
        occurredAt: "2026-03-01T12:00:00Z",
      })
    ).toContain("appointment.startsAt");
  });

  it("accepts a payload whose timestamps carry a zone", () => {
    expect(gateRejection(bookedPayload())).toBe("");
  });

  it("starts a run that carried no payload at all", async () => {
    // A manual run from the canvas or the execute route. The entry node has no
    // sample of its own to stand in with, so downstream nodes see an empty object
    // and the run proceeds rather than failing on a missing payload.
    const result = await executeWorkflow(
      {
        graph: graphFor({
          operator: "before",
          dateTime: "2026-03-11T00:00:00Z",
        }),
        executionId: "exec_no_payload",
        workflowId: "workflow_event_timestamp",
      },
      undefined,
      store
    );

    expect(result.results.trigger_1?.success).toBe(true);
    expect(result.results.trigger_1?.data).toEqual({});
    // Nothing resolved the timestamp, so the comparison is false and the run took
    // the other branch. It ran: an absent payload is not an error.
    expect(result.results.condition_node?.success).toBe(true);
  });
});
