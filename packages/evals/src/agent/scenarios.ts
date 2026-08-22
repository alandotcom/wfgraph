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
      name: "appointment.booked",
      label: "Appointment booked",
      correlationPath: "appointmentId",
      payloadFields: [
        { path: "appointmentId", type: "string" },
        { path: "customer.email", type: "string" },
        { path: "startsAt", type: "timestamp" },
      ],
    },
    {
      name: "appointment.rescheduled",
      label: "Appointment rescheduled",
      correlationPath: "appointmentId",
      payloadFields: [
        { path: "appointmentId", type: "string" },
        { path: "customer.email", type: "string" },
        { path: "startsAt", type: "timestamp" },
        { path: "previousStartsAt", type: "timestamp" },
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
        startEvents: ["applicant.created"],
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: "score-applicant" },
            sourceHandle: "started",
          },
        ],
      },
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
        startEvents: ["applicant.created"],
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
      },
      intentCriteria: [
        "The answer explains that the available actions cannot send SMS.",
        "The graph contains no invented SMS action.",
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
        startEvents: ["applicant.created"],
      },
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
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        preserveNodeIds: ["score", "notify"],
      },
      intentCriteria: [
        "Withdrawal cancels the matching applicant's in-progress run.",
        "The started path keeps its prior behavior.",
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
        startEvents: ["applicant.created"],
        cancelEvents: ["applicant.withdrawn"],
        requiredFlows: [
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.condition },
          },
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
      },
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
      },
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
      },
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
            "Start when an appointment is booked or rescheduled. Split by which event arrived. Post a different Slack message for each path using the appointment start time and our primary Slack connection.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        requiredActions: {
          [BUILT_IN_ACTION_IDS.eventSplit]: 1,
          "slack/send-message": 2,
        },
        startEvents: ["appointment.booked", "appointment.rescheduled"],
        requiredFlows: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "event:appointment.booked",
          },
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            target: { kind: "action", actionId: "slack/send-message" },
            sourceHandle: "event:appointment.rescheduled",
          },
        ],
      },
      intentCriteria: [
        "Each Start Event reaches only its matching Slack message.",
        "Each message uses a reference valid for its Event-specific branch.",
      ],
    }),
  },
];
