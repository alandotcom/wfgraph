import type { IntegrationPlugin } from "@rova/shared/plugins/registry";
import { registerIntegration } from "@rova/shared/plugins/registry";
import { sendSmsOutput } from "#src/twilio/schemas";

const twilioPlugin: IntegrationPlugin = {
  type: "twilio",
  label: "Twilio",
  description: "Send SMS messages with Twilio Programmable Messaging",

  formFields: [
    {
      id: "accountSid",
      label: "Account SID",
      type: "text",
      placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      configKey: "accountSid",
      envVar: "TWILIO_ACCOUNT_SID",
      helpText: "Find this in your Twilio Console.",
    },
    {
      id: "authToken",
      label: "Auth Token",
      type: "password",
      placeholder: "••••••••",
      configKey: "authToken",
      envVar: "TWILIO_AUTH_TOKEN",
      helpText: "Keep this secret. Used for Basic auth to Twilio API.",
    },
    {
      id: "fromNumber",
      label: "Default From Number",
      type: "text",
      placeholder: "+15551234567",
      configKey: "fromNumber",
      envVar: "TWILIO_FROM_NUMBER",
      helpText: "Optional fallback sender number.",
    },
    {
      id: "messagingServiceSid",
      label: "Default Messaging Service SID",
      type: "text",
      placeholder: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      configKey: "messagingServiceSid",
      envVar: "TWILIO_MESSAGING_SERVICE_SID",
      helpText: "Optional fallback if From is not provided.",
    },
  ],

  actions: [
    {
      slug: "send-sms",
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      output: sendSmsOutput,
      configFields: [
        {
          key: "smsTo",
          label: "To",
          type: "template-input",
          placeholder: "+15551234567",
          required: true,
        },
        {
          key: "testBehavior",
          label: "Test Mode Behavior",
          type: "select",
          defaultValue: "log_only",
          options: [
            { value: "log_only", label: "Log only (do nothing)" },
            { value: "send_to_test_phone", label: "Send to test phone" },
          ],
        },
        {
          key: "testPhoneTo",
          label: "Test Phone Number",
          type: "text",
          placeholder: "+15557654321",
          showWhen: {
            field: "testBehavior",
            equals: "send_to_test_phone",
          },
        },
        {
          key: "smsBody",
          label: "Message",
          type: "template-textarea",
          placeholder: "Hi from workflow {{PreviousNode.value}}",
          rows: 4,
          required: true,
        },
        {
          type: "group",
          label: "Sender",
          defaultExpanded: true,
          fields: [
            {
              key: "smsFrom",
              label: "From Number",
              type: "template-input",
              placeholder: "+15557654321",
            },
            {
              key: "smsMessagingServiceSid",
              label: "Messaging Service SID",
              type: "template-input",
              placeholder: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            },
          ],
        },
        {
          type: "group",
          label: "Advanced",
          fields: [
            {
              key: "smsStatusCallback",
              label: "Status Callback URL",
              type: "template-input",
              placeholder: "https://example.com/twilio/status",
            },
            {
              key: "smsMediaUrls",
              label: "Media URLs (comma separated)",
              type: "template-input",
              placeholder: "https://example.com/image.png",
            },
          ],
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(twilioPlugin);

export default twilioPlugin;
