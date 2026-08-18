/**
 * A small extension catalog for the tool tests: two integration actions, one
 * host action, two Events and two integrations.
 *
 * Small on purpose. A tool is judged on how it filters, shapes and refuses, and
 * every one of those is visible in a handful of entries.
 */

import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

export const fixtureCatalog: ExtensionCatalog = {
  events: [
    {
      name: "applicant.created",
      label: "Applicant created",
      description: "A new applicant reached the pipeline.",
      correlationPath: "applicantId",
      payloadFields: [
        { path: "applicantId", type: "string" },
        { path: "email", type: "string", description: "Contact address." },
        { path: "score", type: "number", nullable: true },
      ],
    },
    {
      name: "applicant.withdrawn",
      label: "Applicant withdrawn",
      payloadFields: [{ path: "applicantId", type: "string" }],
    },
  ],
  actions: [
    {
      id: "slack/send-message",
      label: "Send Slack message",
      description: "Post a message to a Slack channel.",
      category: "Messaging",
      integration: "slack",
      sideEffect: true,
      configFields: [
        {
          key: "channel",
          label: "Channel",
          type: "template-input",
          required: true,
        },
        {
          label: "Message",
          type: "group",
          fields: [
            {
              key: "text",
              label: "Text",
              type: "template-textarea",
              required: true,
            },
            {
              key: "tone",
              label: "Tone",
              type: "select",
              options: [
                { value: "plain", label: "Plain" },
                { value: "alert", label: "Alert" },
              ],
            },
          ],
        },
      ],
      outputFields: [
        { path: "ts", type: "string", description: "Slack message timestamp." },
        { path: "channelId", type: "string" },
      ],
    },
    {
      id: "linear/create-issue",
      label: "Create Linear issue",
      description: "Open an issue in a Linear team.",
      category: "Tracking",
      integration: "linear",
      sideEffect: true,
      configFields: [
        {
          key: "title",
          label: "Title",
          type: "template-input",
          required: true,
        },
      ],
      outputFields: [{ path: "issue.id", type: "string" }],
    },
    {
      id: "score-applicant",
      label: "Score applicant",
      description: "Read a score for the applicant without changing anything.",
      category: "Scoring",
      configFields: [
        { key: "applicantId", label: "Applicant", type: "template-input" },
      ],
      outputFields: [{ path: "score", type: "number" }],
    },
  ],
  integrations: [
    {
      type: "slack",
      label: "Slack",
      description: "Slack workspace.",
      credentialFields: {
        botToken: { label: "Bot token", type: "password" },
      },
      hasTest: true,
    },
    {
      type: "linear",
      label: "Linear",
      description: "Linear workspace.",
      credentialFields: { apiKey: { label: "API key", type: "password" } },
      hasTest: false,
    },
  ],
};
