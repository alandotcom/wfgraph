import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { TwilioIcon } from "./icon";

const twilioPlugin: IntegrationPlugin = {
  type: "twilio",
  label: "Twilio",
  description: "Send SMS messages with Twilio Programmable Messaging",

  icon: TwilioIcon,

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

  testConfig: {
    getTestFunction: async () => {
      const { testTwilio } = await import("./test");
      return testTwilio;
    },
  },

  actions: [
    {
      slug: "send-sms",
      label: "Send SMS",
      description: "Send an SMS via Twilio",
      category: "Twilio",
      stepFunction: "sendSmsStep",
      stepImportPath: "send-sms",
      outputFields: [
        { field: "sid", description: "Message SID" },
        { field: "status", description: "Delivery status" },
        { field: "to", description: "Recipient phone number" },
      ],
      configFields: [
        {
          key: "smsTo",
          label: "To",
          type: "template-input",
          placeholder: "+15551234567",
          required: true,
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
