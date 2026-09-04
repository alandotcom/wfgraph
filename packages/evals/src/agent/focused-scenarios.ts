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
        exactActions: { "score-applicant": 1 },
        exactEvents: { start: ["applicant.created"], cancel: [] },
        efficiencyBudget: {
          maxModelCalls: 12,
          maxToolCalls: 24,
          maxGraphRevisions: 6,
          maxRefusals: 4,
        },
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
        exactActions: { "slack/send-message": 1 },
        exactEvents: { start: ["applicant.created"], cancel: [] },
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
        answerMustMention: ["Slack", "connection"],
        requiredPublishBlocker: {
          kind: "missing_integration",
          messageMustMention: ["needs a Slack connection"],
        },
        allowedPublishBlockerKinds: ["missing_integration"],
      },
      intentCriteria: [
        "The workflow is built as far as possible.",
        "The answer says that a Slack connection is required.",
      ],
    }),
  },
  {
    name: "starts from a connected integration Event",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When a candidate referral arrives through Slack, score the applicant using its applicantId. Use our primary Slack connection.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: { "score-applicant": 1 },
        exactEvents: { start: ["slack/candidate.referred"], cancel: [] },
        requiredLifecycleRules: {
          connectionIds: { "slack/candidate.referred": "slack-primary" },
        },
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
      intentCriteria: [
        "The Slack candidate referral starts the workflow through the primary Slack connection.",
        "The score step reads applicantId from the referral Event.",
      ],
    }),
  },
  {
    name: "builds a blocked draft for an unconnected integration Event",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When a candidate referral arrives through Slack, score the applicant using its applicantId. Slack is not connected yet, so build the useful draft and tell me what remains.",
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        exactActions: { "score-applicant": 1 },
        exactEvents: { start: ["slack/candidate.referred"], cancel: [] },
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
      expectedCompletion: {
        outcome: "blocked",
        answerMustMention: ["Slack"],
        answerMustMentionOneOf: ["connect", "connection", "connected"],
        requiredPublishBlocker: {
          kind: "invalid_event",
          messageMustMention: ["needs a Connection"],
        },
        allowedPublishBlockerKinds: ["invalid_event"],
      },
      intentCriteria: [
        "The draft contains the requested workflow structure.",
        "The answer says that a Slack connection is required before publication.",
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
        exactActions: {},
        exactEvents: { start: [], cancel: [] },
        editSafety: { forbiddenMutations: "all" },
      },
      expectedCompletion: {
        outcome: "unsupported",
        answerMustMentionOneOf: ["SMS", "text message", "texting"],
      },
      intentCriteria: [
        "The answer explains that the available actions cannot send SMS.",
        "The graph contains no invented SMS action.",
      ],
    }),
  },
  {
    name: "asks which Event should start an ambiguous workflow",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "I need an applicant follow-up workflow, but I have not chosen the trigger Event. Ask me which Event should start the workflow before making any changes.",
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        exactActions: {},
        exactEvents: { start: [], cancel: [] },
        editSafety: { forbiddenMutations: "all" },
      },
      expectedCompletion: {
        outcome: "clarification",
        questionMustMention: ["event"],
      },
      intentCriteria: [
        "The answer asks which Event should start the applicant follow-up workflow.",
        "The graph remains empty while the trigger Event is unspecified.",
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
        exactActions: {
          [BUILT_IN_ACTION_IDS.eventSplit]: 1,
          "slack/send-message": 2,
        },
        exactEvents: {
          start: ["app/appointment.created", "app/appointment.rescheduled"],
          cancel: [],
        },
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            sourceHandle: "started",
          },
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
        requiredExclusiveBranches: [
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.eventSplit,
            },
            branches: [
              {
                sourceHandle: "event:app/appointment.created",
                target: { kind: "action", actionId: "slack/send-message" },
              },
              {
                sourceHandle: "event:app/appointment.rescheduled",
                target: { kind: "action", actionId: "slack/send-message" },
              },
            ],
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
        requiredPublishBlocker: {
          kind: "missing_required_field",
          messageMustMention: ["missing required field", "channel"],
        },
        allowedPublishBlockerKinds: ["missing_required_field"],
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
        exactActions: { "appointments/cancel": 1 },
        exactEvents: { start: ["app/appointment.created"], cancel: [] },
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
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactEvents: { start: ["app/appointment.created"], cancel: [] },
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
        exactActions: {
          "score-applicant": 1,
          "slack/send-message": 1,
        },
        exactEvents: { start: ["applicant.created"], cancel: [] },
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
        exactActions: {
          "score-applicant": 1,
          "slack/send-message": 1,
        },
        exactEvents: {
          start: ["applicant.created"],
          cancel: ["applicant.withdrawn"],
        },
        requiredLifecycleRules: {
          concurrency: "newest-wins",
          allowManualStart: true,
          correlationPaths: { "applicant.created": "applicantId" },
        },
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
                      field: "email",
                      fieldType: "string",
                      operator: "is_set",
                    },
                  ],
                },
              ],
            },
          },
        ],
        editSafety: {
          protectedNodeIds: ["score", "notify"],
          protectedEdgeIds: ["entry-score", "score-notify"],
        },
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
        exactActions: { "score-applicant": 1 },
        exactEvents: { start: ["applicant.created"], cancel: [] },
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
    name: "filters a Cancel Event before canceling a run",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            'When an appointment is created, wait one day. Cancel the in-progress run only when the appointment canceled Event has reason "patient request".',
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        exactActions: { [BUILT_IN_ACTION_IDS.wait]: 1 },
        exactEvents: {
          start: ["app/appointment.created"],
          cancel: ["app/appointment.canceled"],
        },
        requiredCancelFilters: [
          {
            event: "app/appointment.canceled",
            filter: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "reason",
                      fieldType: "string",
                      operator: "equals",
                      value: "patient request",
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
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            sourceHandle: "started",
          },
        ],
        requiredDurations: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            key: "waitDuration",
            duration: "1d",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Only a canceled appointment with reason patient request ends the run.",
        "The workflow does not use a Condition step for the Cancel Event filter.",
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
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactEvents: { start: ["app/appointment.created"], cancel: [] },
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
