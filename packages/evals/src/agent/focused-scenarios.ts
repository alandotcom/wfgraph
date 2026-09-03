import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { AgentDocument } from "@wfgraph/agent/document";
import type { AgentEvalInput } from "#src/agent/types";
import {
  configuredApplicantDocument,
  connectedIntegrations,
  emptyDocument,
  evalCatalog,
  scenario,
} from "#src/agent/scenario-fixtures";

const largeCatalog: ExtensionCatalog = {
  ...evalCatalog,
  actions: [
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `generated/action-${index}`,
      label: `Generated action ${index}`,
      description: `An unrelated generated action numbered ${index}.`,
      category: "Generated",
      configFields: [],
      outputFields: [],
    })),
    ...evalCatalog.actions,
  ],
  events: [
    ...Array.from({ length: 30 }, (_, index) => ({
      name: `generated/event-${index}`,
      label: `Generated Event ${index}`,
      description: `An unrelated generated Event numbered ${index}.`,
      payloadFields: [],
    })),
    ...evalCatalog.events,
  ],
};

const largeWorkflowStepIds = Array.from(
  { length: 24 },
  (_, index) => `existing-${index}`
);

const largeWorkflowDocument: AgentDocument = {
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
          },
        },
      },
    },
    ...largeWorkflowStepIds.map((id, index) => ({
      id,
      type: "action" as const,
      position: { x: 0, y: 0 },
      data: {
        label: `Existing step ${index}`,
        type: "action" as const,
        config: { actionType: "score-applicant" },
      },
    })),
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
          text: "Existing notification",
        },
      },
    },
  ],
  edges: [
    {
      id: "entry-existing-0",
      source: "entry",
      target: "existing-0",
      sourceHandle: "started",
    },
    ...largeWorkflowStepIds.slice(1).map((id, index) => ({
      id: `existing-${index}-${id}`,
      source: `existing-${index}`,
      target: id,
    })),
    {
      id: "existing-23-notify",
      source: "existing-23",
      target: "notify",
    },
  ],
};

export const focusedScenarios: Array<{
  name: string;
  input: AgentEvalInput;
}> = [
  {
    name: "finds requested capabilities in a large catalog",
    input: {
      ...scenario({
        messages: [
          {
            role: "user",
            content:
              "When an applicant is created, score them. Use only the requested Event and action.",
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
            maxRefusals: 2,
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
          "The agent finds the requested action and Event through filtered discovery.",
          "Unrelated catalog entries do not change the workflow.",
        ],
      }),
      catalog: largeCatalog,
    },
  },
  {
    name: "updates a selected node in a large workflow",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Change only Notify recruiting's channel to #operations. Keep every other node and connection unchanged.",
        },
      ],
      document: largeWorkflowDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: {
          "score-applicant": largeWorkflowStepIds.length,
          "slack/send-message": 1,
        },
        exactEvents: { start: ["applicant.created"], cancel: [] },
        editSafety: {
          protectedNodeIds: ["entry", ...largeWorkflowStepIds],
          protectedEdgeIds: largeWorkflowDocument.edges.map((edge) => edge.id),
        },
        efficiencyBudget: {
          maxModelCalls: 8,
          maxToolCalls: 10,
          maxGraphRevisions: 1,
          maxRefusals: 0,
        },
        requiredConfigs: [
          {
            node: {
              kind: "action",
              actionId: "slack/send-message",
              label: "Notify recruiting",
            },
            values: { channel: "#operations" },
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Only the selected notification node changes.",
        "The agent reads later topology pages and inspects the selected node's config.",
      ],
    }),
  },
  {
    name: "inserts two waits on the same path",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Between Score applicant and Notify recruiting, wait one day and then wait two more days. Call the waits First wait and Second wait. Change nothing else.",
        },
      ],
      document: configuredApplicantDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: {
          "score-applicant": 1,
          [BUILT_IN_ACTION_IDS.wait]: 2,
          "slack/send-message": 1,
        },
        exactEvents: { start: ["applicant.created"], cancel: [] },
        editSafety: {
          protectedNodeIds: ["entry", "score", "notify"],
          protectedEdgeIds: ["entry-score"],
          forbiddenMutations: ["add_node", "connect_nodes", "disconnect_nodes"],
        },
        efficiencyBudget: {
          maxModelCalls: 12,
          maxToolCalls: 16,
          maxGraphRevisions: 4,
          maxRefusals: 0,
        },
        requiredFlows: [
          {
            source: { kind: "action", actionId: "score-applicant" },
            target: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.wait,
              label: "First wait",
            },
          },
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.wait,
              label: "First wait",
            },
            target: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.wait,
              label: "Second wait",
            },
          },
          {
            source: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.wait,
              label: "Second wait",
            },
            target: { kind: "action", actionId: "slack/send-message" },
          },
        ],
        requiredDurations: [
          {
            node: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.wait,
              label: "First wait",
            },
            key: "waitDuration",
            duration: "1d",
          },
          {
            node: {
              kind: "action",
              actionId: BUILT_IN_ACTION_IDS.wait,
              label: "Second wait",
            },
            key: "waitDuration",
            duration: "2d",
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The two waits run in the requested order between scoring and notification.",
        "Each insertion is an atomic graph change and unrelated records are preserved.",
      ],
    }),
  },
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
    name: "waits for the same entity on a connected integration Event",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an applicant is created, wait up to 7 days for a Slack candidate referral for that same applicant. Use our primary Slack connection.",
        },
      ],
      document: emptyDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: { [BUILT_IN_ACTION_IDS.wait]: 1 },
        exactEvents: { start: ["applicant.created"], cancel: [] },
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            sourceHandle: "started",
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            values: { waitMode: "event" },
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
            events: ["slack/candidate.referred"],
            exact: true,
          },
        ],
        requiredWaitSubscriptions: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            event: "slack/candidate.referred",
            connectionId: "slack-primary",
            matchRule: {
              field: "applicantId",
              operator: "equals",
              referencePath: "applicantId",
            },
          },
        ],
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The Wait resumes only for a Slack referral carrying the current run's applicant id.",
        "The Wait uses the primary Slack Connection and times out after seven days.",
      ],
    }),
  },
  {
    name: "waits inside a daily window with an elapsed-time gate",
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "When an appointment is created, wait until appointment.startsAt. Continue only from 09:00 through 17:00 America/New_York, and skip the branch if no time would actually elapse.",
        },
      ],
      document: emptyDocument,
      integrations: [],
      expected: {
        exactActions: { [BUILT_IN_ACTION_IDS.wait]: 1 },
        exactEvents: { start: ["app/appointment.created"], cancel: [] },
        requiredFlows: [
          {
            source: { kind: "lifecycle" },
            target: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            sourceHandle: "started",
          },
        ],
        requiredConfigs: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            values: {
              waitMode: "delay",
              waitDelayTimingMode: "until",
              waitGateMode: "require_actual_wait",
              waitAllowedHoursMode: "daily_window",
              waitAllowedStartTime: "09:00",
              waitAllowedEndTime: "17:00",
              waitTimezone: "America/New_York",
            },
          },
        ],
        forbiddenConfigKeys: [
          {
            node: { kind: "action", actionId: BUILT_IN_ACTION_IDS.wait },
            keys: ["waitDuration"],
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
        "The Wait uses the appointment start timestamp as its target.",
        "The Wait shifts completion into the requested New York daily window.",
        "The Wait skips the branch when the computed target is already due.",
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
