import type { IntegrationPlugin } from "@/shared/plugins/registry";
import { registerIntegration } from "@/shared/plugins/registry";

const slackPlugin: IntegrationPlugin = {
  type: "slack",
  label: "Slack",
  description: "Send messages to Slack channels",

  formFields: [
    {
      id: "apiKey",
      label: "Bot Token",
      type: "password",
      placeholder: "xoxb-...",
      configKey: "apiKey",
      envVar: "SLACK_API_KEY",
      helpText: "Create a Slack app and get your Bot Token from ",
      helpLink: {
        text: "api.slack.com/apps",
        url: "https://api.slack.com/apps",
      },
    },
  ],

  actions: [
    {
      slug: "send-message",
      label: "Send Slack Message",
      description: "Send a message to a Slack channel",
      category: "Slack",
      stepFunction: "sendSlackMessageStep",
      stepImportPath: "send-slack-message",
      outputFields: [
        { path: "ts", description: "Message timestamp" },
        { path: "channel", description: "Channel ID" },
      ],
      configFields: [
        {
          key: "slackChannel",
          label: "Channel",
          type: "text",
          placeholder: "#general or {{NodeName.channel}}",
          example: "#general",
          required: true,
        },
        {
          key: "slackMessage",
          label: "Message",
          type: "template-textarea",
          placeholder:
            "Your message. Use {{NodeName.field}} to insert data from previous nodes.",
          rows: 4,
          example: "Hello from my workflow!",
          required: true,
        },
        {
          key: "testBehavior",
          label: "Test Mode Behavior",
          type: "select",
          defaultValue: "log_only",
          options: [
            { value: "log_only", label: "Log only (do nothing)" },
            { value: "send_message", label: "Send real Slack message" },
          ],
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(slackPlugin);

export default slackPlugin;
