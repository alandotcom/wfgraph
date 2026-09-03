import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { AgentEvalInput } from "#src/agent/types";
import {
  configuredApplicantDocument,
  connectedIntegrations,
  emptyDocument,
  scenario,
} from "#src/agent/scenario-fixtures";

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
        requiredStartFilters: [
          {
            event: "applicant.created",
            filter: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "score",
                      fieldType: "number",
                      operator: "greater_or_equal",
                      value: 80,
                    },
                  ],
                },
              ],
            },
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
