import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { AgentEvalInput } from "#src/agent/types";
import {
  configuredApplicantDocument,
  connectedIntegrations,
  emptyDocument,
  scenario,
} from "#src/agent/scenario-fixtures";

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
        exactActions: {
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.condition]: 1,
          "linear/create-issue": 1,
          "slack/send-message": 1,
        },
        exactEvents: {
          start: ["applicant.created"],
          cancel: ["applicant.withdrawn"],
        },
        efficiencyBudget: {
          maxModelCalls: 24,
          maxToolCalls: 48,
          maxGraphRevisions: 12,
          maxRefusals: 8,
        },
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
        exactActions: {
          "crm/get-applicant": 1,
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.condition]: 1,
          "slack/send-message": 1,
        },
        exactEvents: { start: ["applicant.created"], cancel: [] },
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
        exactActions: {
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactEvents: { start: ["applicant.created"], cancel: [] },
        editSafety: {
          protectedNodeIds: ["entry", "score", "notify"],
          protectedEdgeIds: ["entry-score"],
        },
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
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 1,
        },
        exactEvents: {
          start: ["app/appointment.created"],
          cancel: ["app/appointment.canceled"],
        },
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
        exactActions: {
          [BUILT_IN_ACTION_IDS.wait]: 1,
          "slack/send-message": 2,
          "linear/create-issue": 2,
        },
        exactEvents: {
          start: ["app/appointment.created"],
          cancel: ["app/appointment.canceled"],
        },
        requiredStartFilters: [
          {
            event: "app/appointment.created",
            filter: {
              groupLogic: "and",
              groups: [
                {
                  logic: "and",
                  rules: [
                    {
                      field: "appointment.status",
                      fieldType: "string",
                      operator: "equals",
                      value: "confirmed",
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
