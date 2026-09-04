/**
 * Capability scenarios: what the build agent does not yet do reliably.
 *
 * These start at a low pass rate on purpose, which is what separates them from
 * the focused and complex suites. Those two are regression suites and are
 * expected to stay green. A capability scenario graduates into `focused-scenarios`
 * once it passes consistently.
 *
 * Every scenario here carries a `reference`: a graph, built by hand, that
 * satisfies its own expectations. `capability-scenarios.test.ts` holds the
 * reference to the document-only judges with no model in the loop, which proves
 * the task is buildable and the expectations do not contradict each other.
 */

import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { BooleanOperator } from "@wfgraph/shared/conditions/condition-model";
import {
  type ConditionModel,
  compileConditionModel,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { formatTemplateToken } from "@wfgraph/shared/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput } from "#src/agent/types";
import {
  connectedIntegrations,
  emptyDocument,
  evalCatalog,
  scenario,
} from "#src/agent/scenario-fixtures";

const APPOINTMENT_CREATED = "app/appointment.created";
const PAYMENT_SETTLED = "billing/payment.settled";
const SLACK_CONNECTION = "slack-primary";

const ENTRY = "entry";
const ENTRY_LABEL = "Lifecycle";

/**
 * Every path whose value tells a timed-out run from a resumed one.
 *
 * A Wait says it directly through `timedOut` and through the `event` that woke
 * it. It also says it indirectly: a run that timed out carries no payload at
 * all, so any path the awaited Event declares reads as absent. All of these
 * answer the same question, and a scenario that named one would fail a graph
 * that picked another.
 */
function timeoutTellingFields(eventName: string): string[] {
  const event = evalCatalog.events.find(
    (candidate) => candidate.name === eventName
  );
  return [
    "timedOut",
    "event",
    ...(event?.payloadFields ?? []).map((field) => field.path),
  ];
}

function lifecycleNode(): WorkflowNode {
  return {
    id: ENTRY,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: ENTRY_LABEL,
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: [APPOINTMENT_CREATED],
          cancelEvents: [],
          concurrency: "unlimited",
          allowManualStart: false,
        },
      },
    },
  };
}

function actionNode(input: {
  id: string;
  label: string;
  actionType: string;
  config?: Record<string, unknown>;
}): WorkflowNode {
  return {
    id: input.id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: input.label,
      type: "action",
      config: { actionType: input.actionType, ...input.config },
    },
  };
}

/** A Condition node carrying both the model the judges read and its expression. */
function conditionNode(input: {
  id: string;
  label: string;
  field: string;
  operator: BooleanOperator;
}): WorkflowNode {
  const model: ConditionModel = {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group-1",
        logic: "and",
        conditions: [
          {
            id: "rule-1",
            field: input.field,
            fieldType: "boolean",
            operator: input.operator,
          },
        ],
      },
    ],
  };
  const compiled = compileConditionModel(model);

  return actionNode({
    id: input.id,
    label: input.label,
    actionType: BUILT_IN_ACTION_IDS.condition,
    config: {
      condition: compiled.valid ? compiled.expression : undefined,
      conditionModel: serializeConditionModel(model),
    },
  });
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return { id, source, target, sourceHandle };
}

/** The token addressing one path on an earlier step, spelled the way the engine reads it. */
function token(nodeId: string, nodeLabel: string, fieldPath: string): string {
  return formatTemplateToken({ nodeId, nodeLabel, fieldPath });
}

const startedFrom = (target: string, id: string) =>
  edge(id, ENTRY, target, LIFECYCLE_STARTED_HANDLE);

/** The lookup every scenario below uses to carry a value past an Event wait. */
function appointmentLookup(id: string, label: string): WorkflowNode {
  return actionNode({
    id,
    label,
    actionType: "appointments/get",
    config: {
      appointmentId: token(ENTRY, ENTRY_LABEL, "appointment.id"),
    },
  });
}

function paymentWait(id: string, label: string): WorkflowNode {
  return actionNode({
    id,
    label,
    actionType: BUILT_IN_ACTION_IDS.wait,
    config: {
      waitMode: "event",
      waitFor: [{ event: PAYMENT_SETTLED }],
      waitTimeout: "3d",
      waitTimeoutBehavior: "continue",
    },
  });
}

function slackNode(input: {
  id: string;
  label: string;
  channel: string;
  text: string;
}): WorkflowNode {
  return actionNode({
    id: input.id,
    label: input.label,
    actionType: "slack/send-message",
    config: {
      integrationId: SLACK_CONNECTION,
      channel: input.channel,
      text: input.text,
    },
  });
}

const readsStartPayloadAboveWait: AgentEvalDocument = {
  nodes: [
    lifecycleNode(),
    actionNode({
      id: "date-wait",
      label: "Wait until the day before",
      actionType: BUILT_IN_ACTION_IDS.wait,
      config: {
        waitMode: "delay",
        waitDelayTimingMode: "until",
        waitUntil: token(ENTRY, ENTRY_LABEL, "appointment.startsAt"),
        waitOffset: "-1d",
      },
    }),
    slackNode({
      id: "remind",
      label: "Post the start time",
      channel: "#appointments",
      text: `Starts at ${token(ENTRY, ENTRY_LABEL, "appointment.startsAt")}`,
    }),
    paymentWait("pay-wait", "Wait for the payment"),
  ],
  edges: [
    startedFrom("date-wait", "e1"),
    edge("e2", "date-wait", "remind"),
    edge("e3", "remind", "pay-wait"),
  ],
};

const readsNameFromLookupBelowWait: AgentEvalDocument = {
  nodes: [
    lifecycleNode(),
    appointmentLookup("lookup", "Get Appointment"),
    paymentWait("pay-wait", "Wait for the payment"),
    slackNode({
      id: "notify",
      label: "Post the patient name",
      channel: "#billing",
      text: `Paid for ${token("lookup", "Get Appointment", "patientName")}`,
    }),
  ],
  edges: [
    startedFrom("lookup", "e1"),
    edge("e2", "lookup", "pay-wait"),
    edge("e3", "pay-wait", "notify"),
  ],
};

const cancelsOnlyTheTimedOutRun: AgentEvalDocument = {
  nodes: [
    lifecycleNode(),
    appointmentLookup("lookup", "Get Appointment"),
    paymentWait("pay-wait", "Wait for the payment"),
    conditionNode({
      id: "timed-out",
      label: "Payment never settled?",
      field: "timedOut",
      operator: "is_true",
    }),
    actionNode({
      id: "cancel",
      label: "Cancel the appointment",
      actionType: "appointments/cancel",
      config: {
        appointmentId: token("lookup", "Get Appointment", "appointmentId"),
        reason: "unpaid",
      },
    }),
  ],
  edges: [
    startedFrom("lookup", "e1"),
    edge("e2", "lookup", "pay-wait"),
    edge("e3", "pay-wait", "timed-out"),
    edge("e4", "timed-out", "cancel", "true"),
  ],
};

const readsTimestampFromLookupBelowWait: AgentEvalDocument = {
  nodes: [
    lifecycleNode(),
    appointmentLookup("lookup", "Get Appointment"),
    paymentWait("pay-wait", "Wait for the payment"),
    actionNode({
      id: "date-wait",
      label: "Wait until the day before",
      actionType: BUILT_IN_ACTION_IDS.wait,
      config: {
        waitMode: "delay",
        waitDelayTimingMode: "until",
        waitUntil: token("lookup", "Get Appointment", "startsAt"),
        waitOffset: "-1d",
      },
    }),
    slackNode({
      id: "remind",
      label: "Post the reminder",
      channel: "#appointments",
      text: "Your appointment starts tomorrow.",
    }),
  ],
  edges: [
    startedFrom("lookup", "e1"),
    edge("e2", "lookup", "pay-wait"),
    edge("e3", "pay-wait", "date-wait"),
    edge("e4", "date-wait", "remind"),
  ],
};

export const capabilityScenarios: Array<{
  name: string;
  input: AgentEvalInput;
  reference: AgentEvalDocument;
}> = [
  {
    name: "reads the Start Event payload above an Event wait",
    reference: readsStartPayloadAboveWait,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an appointment is created, wait until one day before it starts and post the start time to #appointments in Slack. After that, wait up to 3 days for the payment to settle.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        // One job: the ordering. Branching a timed-out Wait is its own scenario.
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 2,
          "slack/send-message": 1,
        },
        exactEvents: { start: [APPOINTMENT_CREATED], cancel: [] },
        requiredWaitSubscriptions: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            event: PAYMENT_SETTLED,
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitUntil",
            path: "appointment.startsAt",
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitOffset",
            duration: "-1d",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The date Wait sits above the Event wait, so it can still read the Start Event payload.",
        "The reminder posts the appointment start time rather than a value from the payment Event.",
      ],
    }),
  },
  {
    name: "does not read the Start Event payload below an Event wait",
    reference: readsNameFromLookupBelowWait,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an appointment is created, wait up to 3 days for the payment to settle, then post the patient's name to #billing in Slack.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        exactEvents: { start: [APPOINTMENT_CREATED], cancel: [] },
        requiredWaitSubscriptions: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            event: PAYMENT_SETTLED,
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            path: "patientName",
          },
        ],
        // Below that Wait the Lifecycle Node carries the payment payload, which
        // declares no patient name, so a lookup is where the name comes from.
        forbiddenReferences: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            paths: ["appointment.patientName"],
            fromNode: { kind: "lifecycle" },
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The patient name comes from a step output rather than from the Lifecycle Node below the Wait.",
        "The workflow does not invent a patient name the catalog never offered.",
      ],
    }),
  },
  {
    name: "carries an identifier past a wait that continues on timeout",
    reference: cancelsOnlyTheTimedOutRun,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            'When an appointment is created, wait up to 3 days for the payment to settle. If it never settles, cancel the appointment with the reason "unpaid".',
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          [BUILT_IN_ACTION_IDS.condition]: 1,
          "appointments/get": 1,
          "appointments/cancel": 1,
        },
        exactEvents: { start: [APPOINTMENT_CREATED], cancel: [] },
        requiredWaitSubscriptions: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            event: PAYMENT_SETTLED,
          },
        ],
        requiredConditionRules: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            field: timeoutTellingFields(PAYMENT_SETTLED),
          },
        ],
        requiredPaths: [
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            target: { kind: "action", actionId: "appointments/cancel" },
          },
        ],
        // A timed-out run reaches the cancel step carrying no payment payload,
        // so the id it cancels has to come off a step above the Wait.
        forbiddenReferences: [
          {
            node: { kind: "action", actionId: "appointments/cancel" },
            paths: ["appointmentId"],
            fromNode: { kind: "lifecycle" },
          },
        ],
        requiredNonEmptyConfigs: [
          {
            node: { kind: "action", actionId: "appointments/cancel" },
            keys: ["appointmentId", "reason"],
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Only a run whose payment never settled reaches the cancel step.",
        "The cancelled appointment id survives the Wait rather than being read from the timed-out payload.",
      ],
    }),
  },
  {
    name: "recovers when until timing cannot read the Start Event payload",
    reference: readsTimestampFromLookupBelowWait,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an appointment is created, wait up to 3 days for the payment to settle, then wait until one day before the appointment starts and post a reminder to #appointments in Slack.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 2,
          "appointments/get": 1,
          "slack/send-message": 1,
        },
        exactEvents: { start: [APPOINTMENT_CREATED], cancel: [] },
        // The requested order puts the date Wait below the Event wait, so the
        // start time has to arrive on a lookup placed above that Wait.
        forbiddenReferences: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            paths: ["appointment.startsAt"],
            fromNode: { kind: "lifecycle" },
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitUntil",
            path: "startsAt",
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitOffset",
            duration: "-1d",
          },
        ],
        efficiencyBudget: { maxRefusals: 2 },
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The reminder still fires one day before the appointment start rather than after a fixed duration.",
        "A refused reference is answered by reading the timestamp from a step output, not by changing the timing mode.",
      ],
    }),
  },
];
