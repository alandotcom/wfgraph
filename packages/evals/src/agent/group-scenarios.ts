/**
 * Group scenarios: what the build agent does with a graph that already holds a
 * Group. The agent keeps an existing Group valid through its edits, and it
 * cannot create or ungroup a Group. Layout is edited on the canvas.
 *
 * Every scenario starts from `screeningDocument` and carries a `reference`: a
 * graph, built by hand, that satisfies its own expectations.
 * `group-scenarios.test.ts` holds each reference to the document-only judges
 * and to draft and publish validation, which proves the expectations agree.
 */

import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput, EvalNodeSelector } from "#src/agent/types";
import { connectedIntegrations, scenario } from "#src/agent/scenario-fixtures";

const SCREENING_GROUP_ID = "screening";

const lifecycleNode: WorkflowNode = {
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
        concurrency: "newest-wins",
        allowManualStart: true,
        correlationPaths: { "applicant.created": "applicantId" },
      },
    },
  },
};

/** Group frames carry no layout configuration. */
const screeningFrame: WorkflowNode = {
  id: SCREENING_GROUP_ID,
  type: "group",
  position: { x: 0, y: 0 },
  data: { label: "Screening", type: "group", config: {} },
};

function action(input: {
  id: string;
  label: string;
  config: Record<string, string>;
  inScreening?: boolean;
}): WorkflowNode {
  return {
    id: input.id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: input.label, type: "action", config: input.config },
    parentId: input.inScreening ? SCREENING_GROUP_ID : undefined,
  };
}

const getApplicant = action({
  id: "get",
  label: "Get applicant",
  config: {
    actionType: "crm/get-applicant",
    applicantId: "{{@entry:Lifecycle.applicantId}}",
  },
});

const scoreApplicant = action({
  id: "score",
  label: "Score applicant",
  config: {
    actionType: "score-applicant",
    applicantId: "{{@entry:Lifecycle.applicantId}}",
  },
  inScreening: true,
});

const notifyRecruiting = action({
  id: "notify",
  label: "Notify recruiting",
  config: {
    actionType: "slack/send-message",
    integrationId: "slack-primary",
    channel: "#recruiting",
    text: "Applicant scored: {{@score:Score applicant.score}}",
  },
  inScreening: true,
});

const createTicket = action({
  id: "ticket",
  label: "Create hiring ticket",
  config: {
    actionType: "linear/create-issue",
    integrationId: "linear-primary",
    title: "Review {{@get:Get applicant.email}}",
  },
});

const postUpdate = action({
  id: "announce",
  label: "Post hiring update",
  config: {
    actionType: "slack/send-message",
    integrationId: "slack-primary",
    channel: "#hiring",
    text: "A hiring ticket was opened.",
  },
});

function flow(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

const screeningEdges: WorkflowEdge[] = [
  {
    ...flow("entry-get", "entry", "get"),
    sourceHandle: LIFECYCLE_STARTED_HANDLE,
  },
  flow("get-score", "get", "score"),
  flow("score-notify", "score", "notify"),
  flow("notify-ticket", "notify", "ticket"),
  flow("ticket-announce", "ticket", "announce"),
];

/**
 * A publishable workflow with one Group, "Screening", holding "Score applicant"
 * and "Notify recruiting". "Get applicant" enters the Group, and "Notify
 * recruiting" continues out of it to "Create hiring ticket", so the Group meets
 * the v1 Publish rules. Two steps below the Group belong to no Group.
 */
export const screeningDocument: AgentEvalDocument = {
  nodes: [
    lifecycleNode,
    screeningFrame,
    getApplicant,
    scoreApplicant,
    notifyRecruiting,
    createTicket,
    postUpdate,
  ],
  edges: screeningEdges,
};

const screeningNodeIds = screeningDocument.nodes.map((node) => node.id);
const screeningEdgeIds = screeningEdges.map((edge) => edge.id);

const screeningActions = {
  "crm/get-applicant": 1,
  "score-applicant": 1,
  "slack/send-message": 2,
  "linear/create-issue": 1,
};

const scoreSelector: EvalNodeSelector = {
  kind: "action",
  actionId: "score-applicant",
  label: "Score applicant",
};

const notifySelector: EvalNodeSelector = {
  kind: "action",
  actionId: "slack/send-message",
  label: "Notify recruiting",
};

const ticketSelector: EvalNodeSelector = {
  kind: "action",
  actionId: "linear/create-issue",
  label: "Create hiring ticket",
};

const insertedLogStep = action({
  id: "log",
  label: "Log screening",
  config: {
    actionType: "slack/send-message",
    integrationId: "slack-primary",
    channel: "#screening-log",
    text: "Applicant scored",
  },
  inScreening: true,
});

export const groupScenarios: Array<{
  name: string;
  input: AgentEvalInput;
  reference: AgentEvalDocument;
}> = [
  {
    name: "edits a Group member's config and keeps the Group",
    reference: {
      nodes: screeningDocument.nodes.map((node) =>
        node.id === notifyRecruiting.id
          ? {
              ...node,
              data: {
                ...node.data,
                config: { ...node.data.config, channel: "#screening" },
              },
            }
          : node
      ),
      edges: screeningEdges,
    },
    input: scenario({
      messages: [
        {
          role: "user",
          content: "Change Notify recruiting's channel to #screening.",
        },
      ],
      document: screeningDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: screeningActions,
        editSafety: {
          protectedNodeIds: screeningNodeIds.filter(
            (id) => id !== notifyRecruiting.id
          ),
          protectedEdgeIds: screeningEdgeIds,
        },
        requiredConfigs: [
          { node: notifySelector, values: { channel: "#screening" } },
        ],
        requiredGroups: [
          {
            label: "Screening",
            members: [scoreSelector, notifySelector],
            memberCount: 2,
          },
        ],
        exactGroupCount: 1,
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "Notify recruiting posts to #screening.",
        "Notify recruiting stays in the Screening Group beside Score applicant.",
      ],
    }),
  },
  {
    name: "does not create a Group when asked to group two steps",
    reference: screeningDocument,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Put Create hiring ticket and Post hiring update into a new Group called Follow-up.",
        },
      ],
      document: screeningDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: screeningActions,
        editSafety: { forbiddenMutations: "all" },
        forbiddenGroups: ["Follow-up"],
        exactGroupCount: 1,
      },
      expectedCompletion: {
        outcome: "unsupported",
        answerMustMentionOneOf: ["editor", "canvas"],
      },
      intentCriteria: [
        "The agent creates no Group and leaves the graph as it was.",
        "The answer tells the person to group the steps in the editor.",
      ],
    }),
  },
  {
    name: "refuses to ungroup a Group",
    reference: screeningDocument,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Ungroup Screening so Score applicant and Notify recruiting are no longer in a Group. Keep both steps and their connections.",
        },
      ],
      document: screeningDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: screeningActions,
        editSafety: { forbiddenMutations: "all" },
        requiredGroups: [
          {
            label: "Screening",
            members: [scoreSelector, notifySelector],
            memberCount: 2,
          },
        ],
      },
      expectedCompletion: {
        outcome: "unsupported",
        answerMustMentionOneOf: ["editor", "canvas"],
      },
      intentCriteria: [
        "The agent explains that it cannot ungroup a Group and that the person can ungroup it in the editor.",
        "The answer does not claim that the editor cannot ungroup a Group.",
        "The graph, including the Screening Group, is unchanged.",
      ],
    }),
  },
  {
    name: "refuses to change a Group's layout direction",
    reference: screeningDocument,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Change the Screening Group's layout direction to horizontal.",
        },
      ],
      document: screeningDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: screeningActions,
        editSafety: { forbiddenMutations: "all" },
      },
      expectedCompletion: {
        outcome: "unsupported",
        answerMustMentionOneOf: ["editor", "canvas"],
      },
      intentCriteria: [
        "The Screening Group and its member positions are unchanged.",
        "The answer explains that the Group has no layout-direction setting and suggests dragging members or using Tidy layout in the editor.",
      ],
    }),
  },
  {
    name: "dissolves a Group left with one step and names it",
    reference: {
      nodes: screeningDocument.nodes
        .filter(
          (node) =>
            node.id !== notifyRecruiting.id && node.id !== screeningFrame.id
        )
        .map((node) =>
          node.id === scoreApplicant.id
            ? { ...node, parentId: undefined }
            : node
        ),
      edges: [
        ...screeningEdges.filter(
          (edge) =>
            edge.source !== notifyRecruiting.id &&
            edge.target !== notifyRecruiting.id
        ),
        flow("score-ticket", "score", "ticket"),
      ],
    },
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Delete Notify recruiting and connect Score applicant directly to Create hiring ticket.",
        },
      ],
      document: screeningDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: { ...screeningActions, "slack/send-message": 1 },
        editSafety: {
          protectedEdgeIds: ["entry-get", "get-score", "ticket-announce"],
        },
        requiredFlows: [{ source: scoreSelector, target: ticketSelector }],
        forbiddenGroups: ["Screening"],
        exactGroupCount: 0,
      },
      expectedCompletion: {
        outcome: "ready",
        answerMustMention: ["Screening"],
      },
      intentCriteria: [
        "Notify recruiting is gone and Score applicant leads to Create hiring ticket.",
        "The Screening Group, left with one step, is removed.",
        "The answer tells the person that the Screening Group was removed.",
      ],
    }),
  },
  {
    name: "inserts a step between two Group members inside the Group",
    reference: {
      nodes: [...screeningDocument.nodes, insertedLogStep],
      edges: [
        ...screeningEdges.filter((edge) => edge.id !== "score-notify"),
        flow("score-log", "score", "log"),
        flow("log-notify", "log", "notify"),
      ],
    },
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            'Between Score applicant and Notify recruiting, add a Slack message to #screening-log that says "Applicant scored".',
        },
      ],
      document: screeningDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: { ...screeningActions, "slack/send-message": 3 },
        editSafety: {
          protectedNodeIds: screeningNodeIds,
          protectedEdgeIds: screeningEdgeIds.filter(
            (id) => id !== "score-notify"
          ),
        },
        requiredConfigs: [
          {
            node: { kind: "action", actionId: "slack/send-message" },
            values: { channel: "#screening-log" },
          },
        ],
        requiredFlows: [
          {
            source: scoreSelector,
            target: { kind: "action", actionId: "slack/send-message" },
          },
          {
            source: { kind: "action", actionId: "slack/send-message" },
            target: notifySelector,
          },
        ],
        requiredGroups: [
          {
            label: "Screening",
            members: [scoreSelector, notifySelector],
            memberCount: 3,
          },
        ],
        exactGroupCount: 1,
      },
      expectedCompletion: { outcome: "ready" },
      intentCriteria: [
        "The new Slack step runs after Score applicant and before Notify recruiting.",
        "The new step joins the Screening Group, so the Group keeps one way in and one way out.",
      ],
    }),
  },
  {
    name: "answers which steps a Group contains",
    reference: screeningDocument,
    input: scenario({
      messages: [
        {
          role: "user",
          content:
            "Which steps are inside the Screening Group? Do not change the workflow.",
        },
      ],
      document: screeningDocument,
      integrations: connectedIntegrations,
      expected: {
        exactActions: screeningActions,
        editSafety: { forbiddenMutations: "all" },
      },
      expectedCompletion: {
        outcome: "ready",
        answerMustMention: ["Score applicant", "Notify recruiting"],
      },
      intentCriteria: [
        "The answer names Score applicant and Notify recruiting as the Screening Group's steps.",
        "The graph is unchanged.",
      ],
    }),
  },
];
