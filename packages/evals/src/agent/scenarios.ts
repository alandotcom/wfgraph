import { fixtureCatalog } from "@wfgraph/agent/tools/catalog-fixture";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { AgentEvalInput } from "#src/agent/types";

const emptyDocument: AgentDocument = { nodes: [], edges: [] };

export const evalCatalog: ExtensionCatalog = {
  ...fixtureCatalog,
  events: [
    ...fixtureCatalog.events,
    {
      name: "app/appointment.created",
      label: "Appointment created",
      description: "Raised when a new appointment is booked.",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.startsAt", type: "timestamp" },
        { path: "appointment.patientName", type: "string" },
        { path: "appointment.status", type: "string" },
        { path: "occurredAt", type: "timestamp" },
      ],
    },
    {
      name: "app/appointment.rescheduled",
      label: "Appointment rescheduled",
      description: "Raised when an appointment moves to a new time.",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.startsAt", type: "timestamp" },
        { path: "appointment.patientName", type: "string" },
        { path: "appointment.status", type: "string" },
        { path: "occurredAt", type: "timestamp" },
        { path: "previousStartsAt", type: "timestamp" },
      ],
    },
    {
      name: "app/appointment.canceled",
      label: "Appointment canceled",
      description: "Raised when an appointment is called off.",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment.id", type: "string" },
        { path: "appointment.startsAt", type: "timestamp" },
        { path: "appointment.patientName", type: "string" },
        { path: "appointment.status", type: "string" },
        { path: "occurredAt", type: "timestamp" },
        { path: "reason", type: "string" },
      ],
    },
    {
      name: "billing/payment.settled",
      label: "Payment settled",
      description: "Raised by the billing service when a charge clears.",
      correlationPath: "appointmentId",
      payloadFields: [
        { path: "appointmentId", type: "string" },
        { path: "amountCents", type: "number" },
        { path: "settledAt", type: "timestamp" },
      ],
    },
  ],
  actions: [
    ...fixtureCatalog.actions,
    {
      id: "crm/get-applicant",
      label: "Get applicant",
      description: "Read the applicant's current CRM profile.",
      category: "CRM",
      configFields: [
        {
          key: "applicantId",
          label: "Applicant",
          type: "template-input",
          required: true,
        },
      ],
      outputFields: [
        { path: "email", type: "string" },
        { path: "department", type: "string", nullable: true },
      ],
    },
    {
      id: "appointments/cancel",
      label: "Cancel Appointment",
      description: "Cancels an appointment and records the reason.",
      category: "Appointments",
      sideEffect: true,
      configFields: [
        {
          key: "appointmentId",
          label: "Appointment ID",
          type: "template-input",
          required: true,
        },
        {
          key: "reason",
          label: "Reason",
          type: "text",
          required: true,
        },
      ],
      outputFields: [
        { path: "appointmentId", type: "string" },
        { path: "status", type: "string" },
        { path: "reason", type: "string" },
        { path: "cancelledAt", type: "timestamp" },
      ],
    },
  ],
};

const connectedIntegrations = [
  { id: "slack-primary", type: "slack" },
  { id: "linear-primary", type: "linear" },
];

function scenario(input: Omit<AgentEvalInput, "catalog">): AgentEvalInput {
  return { ...input, catalog: evalCatalog };
}

const configuredApplicantDocument: AgentDocument = {
  nodes: [
    {
      id: "entry",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Lifecycle",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: ["applicant.created"],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
            correlationPaths: { "applicant.created": "applicantId" },
          },
        },
      },
    },
    {
      id: "score",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Score applicant",
        type: "action",
        config: {
          actionType: "score-applicant",
          applicantId: "{{@entry:Lifecycle.applicantId}}",
        },
      },
    },
    {
      id: "notify",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Notify recruiting",
        type: "action",
        config: {
          actionType: "slack/send-message",
          integrationId: "slack-primary",
          channel: "#recruiting",
          text: "Applicant score: {{@score:Score applicant.score}}",
        },
      },
    },
  ],
  edges: [
    {
      id: "entry-score",
      source: "entry",
      target: "score",
      sourceHandle: "started",
    },
    { id: "score-notify", source: "score", target: "notify" },
  ],
};

export const focusedScenarios: Array<{
  name: string;
  input: AgentEvalInput;
}> = [
  {
    name: "creates a basic event-driven workflow",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an applicant is created, score them. Call the steps Lifecycle and Score applicant.",
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        requiredActions: { "score-applicant": 1 },
        exactActions: { "score-applicant": 1 },
        startEvents: ["applicant.created"],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "score-applicant" },
            sourceHandle: "started",
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "score-applicant" },
            key: "applicantId",
            path: "applicantId",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: ["Each applicant is scored after it starts a run."],
    }),
  },
  {
    name: "reports a missing integration connection",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an applicant is created, post their email to #recruiting in Slack.",
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        requiredActions: { "slack/send-message": 1 },
        exactActions: { "slack/send-message": 1 },
        startEvents: ["applicant.created"],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#recruiting" },
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            path: "email",
          },
        ],
      },
      expectedCompletion: {
        outcome: "blocked",
        answerMustMention: ["slack", "requires a connection"],
        publishBlockerMustMention: ["connected slack integration"],
      },
      intentCriteria: [
        "The workflow is built as far as possible.",
        "The answer says that a Slack connection is required.",
      ],
    }),
  },
  {
    name: "does not invent an unavailable SMS action",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Text the applicant when their application is created. Do not substitute another channel.",
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        forbiddenActions: ["sms/send-message", "twilio/send-message"],
        allowedActions: [],
      },
      expectedCompletion: {
        outcome: "unsupported",
      },
      intentCriteria: [
        "The answer explains that the available actions cannot send SMS.",
        "The graph contains no invented SMS action.",
      ],
    }),
  },
  {
    name: "builds an Event Split draft with an unspecified channel",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Start when an appointment is created or rescheduled. Split by which Event arrived and post a different Slack message for each path using the appointment start time. Use our primary Slack connection.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          [BUILT_IN_ACTION_IDS.eventSplit]: 1,
          "slack/send-message": 2,
        },
        exactActions: {
          [BUILT_IN_ACTION_IDS.eventSplit]: 1,
          "slack/send-message": 2,
        },
        startEvents: ["app/appointment.created", "app/appointment.rescheduled"],
        requiredFlows: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "event:app/appointment.created",
          },
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "event:app/appointment.rescheduled",
          },
        ],
        requiredNonEmptyConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            keys: ["text"],
            allMatches: true,
          },
        ],
        distinctConfigValues: [
          {
            nodes: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            count: 2,
          },
        ],
      },
      expectedCompletion: {
        outcome: "blocked",
        answerMustMention: ["channel"],
        publishBlockerMustMention: ["missing required fields", "channel"],
      },
      intentCriteria: [
        "Each Start Event reaches only its matching Slack message.",
        "The answer identifies the missing Slack channel as remaining human configuration.",
      ],
    }),
  },
  {
    name: "uses the host appointment cancellation action",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            'When an appointment is created, cancel it with the reason "Follow-up required".',
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        requiredActions: { "appointments/cancel": 1 },
        exactActions: { "appointments/cancel": 1 },
        startEvents: ["app/appointment.created"],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "appointments/cancel" },
            values: { reason: "Follow-up required" },
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "appointments/cancel" },
            key: "appointmentId",
            path: "appointment.id",
          },
        ],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "appointments/cancel" },
            sourceHandle: "started",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The cancellation uses the appointment id from the Start Event.",
        "The cancellation reason is Follow-up required.",
      ],
    }),
  },
  {
    name: "waits for a production Event with a timeout",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            'When an appointment is created, wait up to 7 days for the next payment settled Event, then post "Payment settled" to #billing in Slack. Use our primary Slack connection.',
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        startEvents: ["app/appointment.created"],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            sourceHandle: "started",
          },
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            target: { kind: "action", actionId: "slack/send-message" },
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            values: { waitMode: "event" },
          },
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#billing", text: "Payment settled" },
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitTimeout",
            duration: "7d",
          },
        ],
        requiredWaitEvents: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            events: ["billing/payment.settled"],
            exact: true,
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The Wait resumes on the payment settled Event and times out after seven days.",
      ],
    }),
  },
  {
    name: "repairs a missing required Slack message",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Finish Notify recruiting so it posts the applicant email, then make the workflow ready.",
        },
      ],
      document: {
        nodes: configuredApplicantDocument.nodes.map((node) =>
          node.id === "notify"
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: { ...node.data.config, text: "" },
                },
              }
            : node
        ),
        edges: configuredApplicantDocument.edges,
      },
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          "score-applicant": 1,
          "slack/send-message": 1,
        },
        exactActions: {
          "score-applicant": 1,
          "slack/send-message": 1,
        },
        startEvents: ["applicant.created"],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            path: "email",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Notify recruiting reads the applicant email from an upstream step.",
      ],
    }),
  },
  {
    name: "adds cancellation to an existing workflow",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Cancel an in-progress run when the same applicant withdraws. Keep the started path unchanged.",
        },
      ],
      document: configuredApplicantDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          "score-applicant": 1,
          "slack/send-message": 1,
        },
        exactActions: {
          "score-applicant": 1,
          "slack/send-message": 1,
        },
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        preserveNodeIds: ["score", "notify"],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Withdrawal cancels the matching applicant's in-progress run.",
        "The started path keeps its prior behavior.",
      ],
    }),
  },
  {
    name: "filters a Start Event before opening a run",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an applicant is created, start a run only if the Event score is at least 80, then score the applicant.",
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        requiredActions: { "score-applicant": 1 },
        exactActions: { "score-applicant": 1 },
        forbiddenActions: [BUILT_IN_ACTION_IDS.condition],
        startEvents: ["applicant.created"],
        requiredStartFilterRules: [
          {
            event: "applicant.created",
            field: "score",
            operator: "greater_or_equal",
            value: 80,
          },
        ],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "score-applicant" },
            sourceHandle: "started",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The score filter rejects arrivals before a run opens.",
        "The workflow does not use a Condition step for the Start Event filter.",
      ],
    }),
  },
  {
    name: "waits until one day before an Event timestamp",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an appointment is created, wait until one day before appointment.startsAt, then post the start time to #appointments in Slack using our primary connection.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        startEvents: ["app/appointment.created"],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            sourceHandle: "started",
          },
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            target: { kind: "action", actionId: "slack/send-message" },
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            values: {
              waitMode: "delay",
              waitDelayTimingMode: "until",
            },
          },
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#appointments" },
          },
        ],
        forbiddenConfigKeys: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            keys: ["waitDuration"],
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitOffset",
            duration: "-1d",
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitUntil",
            path: "appointment.startsAt",
          },
          {
            node: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            path: "appointment.startsAt",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The Wait targets the appointment start timestamp with a negative one-day offset.",
        "The workflow does not replace the requested calendar target with a one-day duration.",
      ],
    }),
  },
];

export const complexScenarios: Array<{
  name: string;
  input: AgentEvalInput;
}> = [
  {
    name: "builds applicant triage with a conditional escalation",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an applicant is created, score them. If the score is at least 80, create a Linear issue titled with the applicant email and alert #recruiting in Slack. If they withdraw, cancel the run. Use our primary connections.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.condition]: 1,
          "linear/create-issue": 1,
          "slack/send-message": 1,
        },
        exactActions: {
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.condition]: 1,
          "linear/create-issue": 1,
          "slack/send-message": 1,
        },
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        requiredPaths: [
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
          },
        ],
        requiredFlows: [
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            target: { kind: "action", actionId: "linear/create-issue" },
            sourceHandle: "true",
          },
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "true",
          },
        ],
        requiredGates: [
          {
            gate: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            target: { kind: "action", actionId: "linear/create-issue" },
            sourceHandle: "true",
          },
          {
            gate: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "true",
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#recruiting" },
          },
        ],
        requiredConditionRules: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            field: "score",
            operator: "greater_or_equal",
            value: 80,
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "linear/create-issue" },
            key: "title",
            path: "email",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Only applicants with scores of at least 80 reach both escalation actions.",
        "The issue title uses the applicant email from an available upstream reference.",
        "Withdrawal cancels runs for the matching applicant.",
      ],
    }),
  },
  {
    name: "builds parallel enrichment with an AND-join",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "For each new applicant, fetch their CRM profile and score them in parallel. After both finish, continue only when the score is over 70 and the CRM department is set. Alert #recruiting in Slack on the true branch.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          "crm/get-applicant": 1,
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.condition]: 1,
          "slack/send-message": 1,
        },
        exactActions: {
          "crm/get-applicant": 1,
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.condition]: 1,
          "slack/send-message": 1,
        },
        startEvents: ["applicant.created"],
        requiredFlows: [
          {
            source: { kind: "action", actionId: "crm/get-applicant" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
          },
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
          },
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "true",
          },
        ],
        requiredGates: [
          {
            gate: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "true",
          },
        ],
        requiredParallel: [
          {
            first: { kind: "action", actionId: "crm/get-applicant" },
            second: { kind: "action", actionId: "score-applicant" },
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#recruiting" },
          },
        ],
        requiredConditionRules: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            field: "score",
            operator: "greater_than",
            value: 70,
          },
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            field: "department",
            operator: "is_set",
          },
        ],
        requiredConditionLogic: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
            groupLogic: "and",
            ruleLogic: "and",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The CRM lookup and scoring fan out independently from their common predecessor.",
        "The Condition is an AND-join that tests outputs from both lookups.",
      ],
    }),
  },
  {
    name: "inserts a wait without rewriting unrelated steps",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Wait two days after Score applicant before Notify recruiting. Change nothing else.",
        },
      ],
      document: configuredApplicantDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactActions: { [BUILT_IN_ACTION_IDS.wait]: 1 },
        preserveNodeIds: ["entry", "score", "notify"],
        requiredFlows: [
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
          },
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            target: { kind: "action", actionId: "slack/send-message" },
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            values: { waitMode: "delay" },
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitDuration",
            duration: "2d",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The existing steps retain their prior configuration.",
        "A two-day delay sits between scoring and notification.",
      ],
    }),
  },
  {
    name: "routes two appointment Events through an Event Split",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Start when an appointment is created or rescheduled. Split by which Event arrived. Post a different Slack message to #appointments for each path using the appointment start time and our primary Slack connection.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          [BUILT_IN_ACTION_IDS.eventSplit]: 1,
          "slack/send-message": 2,
        },
        exactActions: {
          [BUILT_IN_ACTION_IDS.eventSplit]: 1,
          "slack/send-message": 2,
        },
        startEvents: ["app/appointment.created", "app/appointment.rescheduled"],
        requiredFlows: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "event:app/appointment.created",
          },
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "event:app/appointment.rescheduled",
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#appointments" },
            allMatches: true,
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            path: "appointment.startsAt",
            allMatches: true,
          },
        ],
        distinctConfigValues: [
          {
            nodes: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            count: 2,
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Each Start Event reaches only its matching Slack message.",
        "Each message uses a reference valid for its Event-specific branch.",
      ],
    }),
  },
  {
    name: "builds an appointment reminder that cancels with the host Event",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an appointment is created, wait one day and post its start time to #appointments in Slack. Cancel the in-progress run if that appointment is canceled. Use our primary Slack connection.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        startEvents: ["app/appointment.created"],
        cancelEvents: ["app/appointment.canceled"],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            sourceHandle: "started",
          },
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            target: { kind: "action", actionId: "slack/send-message" },
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            values: { waitMode: "delay" },
          },
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#appointments" },
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitDuration",
            duration: "1d",
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            key: "text",
            path: "appointment.startsAt",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "A one-day delay sits before the Slack reminder.",
        "The reminder uses the appointment start time from the Start Event.",
        "Cancellation correlates the canceled appointment to its in-progress run.",
      ],
    }),
  },
  {
    name: "builds a filtered appointment sequence within one turn",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an appointment is created, start only if appointment.status is confirmed. Post an immediate booking message to #appointments. Then wait until one day before appointment.startsAt. At that time, post a reminder to #appointments, create a Linear issue titled Prepare for the appointment, and create another Linear issue titled Confirm staffing. Cancel an in-progress run if the appointment is canceled. Use our primary connections.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 2,
          "linear/create-issue": 2,
        },
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 2,
          "linear/create-issue": 2,
        },
        forbiddenActions: [BUILT_IN_ACTION_IDS.condition],
        startEvents: ["app/appointment.created"],
        cancelEvents: ["app/appointment.canceled"],
        requiredStartFilterRules: [
          {
            event: "app/appointment.created",
            field: "appointment.status",
            operator: "equals",
            value: "confirmed",
          },
        ],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "started",
          },
          {
            source: { kind: "action", actionId: "slack/send-message" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
          },
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            target: { kind: "action", actionId: "slack/send-message" },
          },
        ],
        requiredPaths: [
          {
            source: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            target: { kind: "action", actionId: "linear/create-issue" },
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            values: {
              waitMode: "delay",
              waitDelayTimingMode: "until",
            },
          },
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#appointments" },
            allMatches: true,
          },
          {
            node: { kind: "action", actionId: "linear/create-issue" },
            values: { title: "Prepare for the appointment" },
          },
          {
            node: { kind: "action", actionId: "linear/create-issue" },
            values: { title: "Confirm staffing" },
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitOffset",
            duration: "-1d",
          },
        ],
        requiredReferences: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitUntil",
            path: "appointment.startsAt",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The workflow completes the multi-step request in one agent turn.",
        "The Event filter runs before an Execution opens.",
        "The Wait targets one day before the appointment start timestamp.",
      ],
    }),
  },
];
