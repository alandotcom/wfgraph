/**
 * An Event's datetime field, from the schema an author writes to the branch a run
 * takes.
 *
 * Every link in the chain has its own cases elsewhere. This one holds the chain
 * together against a payload's ISO string being offered as text only, which
 * would give the condition builder string operators and leave the field asking
 * for a moment in time unable to list it at all.
 */

import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { defineEvent } from "#src/backend/extensions/define-event";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { defineAction } from "#src/backend/extensions/define-action";
import {
  isoTimestampString,
  isoTimestampToDate,
} from "@wfgraph/shared/types/timestamp";
import {
  compileConditionModel,
  type ConditionModel,
  createDefaultConditionRule,
  serializeConditionModel,
  TIMESTAMP_OPERATOR_OPTIONS,
} from "@wfgraph/shared/conditions/conditions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import { executionData } from "#src/backend/engine/contracts";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";

/**
 * The datetime field where a handler wants a `Date`. Piping the shared string
 * spelling into the codec keeps the wire form an ISO string on both sides.
 */
function isoTimestampToDateField(description: string) {
  return isoTimestampString(description).pipe(
    Schema.decodeTo(isoTimestampToDate)
  );
}

/**
 * A node that answers with the config it was handed, which is how a case reads
 * what template resolution produced.
 */
const ECHO_ACTION_ID = "test/echo-config";

const echoAction = defineAction({
  id: ECHO_ACTION_ID,
  label: "Echo Config",
  description: "Answers with the value its config resolved to",
  input: Schema.Struct({
    startsAt: Schema.String.annotate({ description: "The value handed in" }),
  }),
  output: Schema.Struct({
    startsAt: Schema.String.annotate({ description: "The value handed in" }),
  }),
  handler: ({ input: handed }) => ({ startsAt: handed.startsAt }),
});

// The engine reaches an action's step through the dispatch port the app builds,
// so the host action these cases run reaches the engine the way a host's would.
const actions = createWorkflowActions(
  assembleExtensions({ actions: [echoAction] }),
  stubWfGraphRuntime()
);

const appointmentBooked = defineEvent({
  name: "app/appointment.booked",
  label: "Appointment booked",
  schema: Schema.Struct({
    appointment: Schema.Struct({
      id: Schema.String.annotate({ description: "Appointment ID" }),
      // The two spellings an author may reach for: a `Date` in a handler, and a
      // string on both sides. Either way the wire form is an ISO string.
      startsAt: isoTimestampToDateField("When the appointment starts"),
    }).annotate({ description: "The appointment" }),
    occurredAt: isoTimestampString("When the event was raised"),
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
        id: "lifecycle_1",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "Lifecycle", type: "lifecycle", config: {} },
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
            startsAt: "{{@lifecycle_1:Lifecycle.appointment.startsAt}}",
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
      {
        id: "edge_t_c",
        source: "lifecycle_1",
        sourceHandle: "started",
        target: "condition_node",
      },
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
        },
        {
          path: "occurredAt",
          description: "When the event was raised",
          type: "timestamp",
        },
      ])
    );
  });

  it("addresses a Date-valued field by its path on the wire", () => {
    // This compiles only because a definition's paths address the payload as it
    // arrives: `startsAt` is a string there and a `Date` only after a decode,
    // and a Correlation Path is a path to a string.
    const keyedOnStart = defineEvent({
      name: "app/appointment.booked.by-time",
      label: "Appointment booked, keyed on its time",
      schema: Schema.Struct({
        startsAt: isoTimestampToDateField("When the appointment starts"),
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
        startPayload: bookedPayload(),
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
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
        startPayload: bookedPayload(),
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
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
        startPayload: bookedPayload(),
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(executionData(result.results.lifecycle_1)).toEqual(bookedPayload());
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
        startPayload: bookedPayload(),
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(executionData(result.results.echo_node)).toEqual({
      success: true,
      data: { startsAt: "2026-03-10T09:00:00-05:00" },
    });
    expect(executionData(result.results.lifecycle_1)).toEqual(bookedPayload());
  });

  it("refuses a payload whose timestamp field carries no zone", () => {
    // The gate is the Event's schema, and its ISO codec requires a zone: a string
    // without one names a different instant on every machine that reads it.
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

  it("refuses a malformed value on a field that stays a string", () => {
    // `occurredAt` never becomes a `Date`, so its own check is the only thing
    // between the sender and the field: `format: "date-time"` tells the editor how
    // to draw the field and refuses nothing.
    const error = gateRejection({
      appointment: { id: "appt_1", startsAt: "2026-03-10T09:00:00-05:00" },
      occurredAt: "banana",
    });

    expect(error).toContain("occurredAt");
    expect(error).not.toContain("banana");
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
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.lifecycle_1?.success).toBe(true);
    expect(executionData(result.results.lifecycle_1)).toEqual({});
    // Nothing resolved the timestamp, so the comparison is false and the run took
    // the other branch. It ran: an absent payload is not an error.
    expect(result.results.condition_node?.success).toBe(true);
  });
});
