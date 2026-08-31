/**
 * Recorded Resend webhook envelopes, pinned from
 * https://resend.com/docs/webhooks/event-types (fetched 2026-08-30).
 *
 * Email events share the delivered example and change `type`. Clicked, bounced,
 * failed and received carry the extra `data` fields those pages document.
 * Domain, contact and suppression clone their created/added examples.
 */

const EMAIL_CREATED_AT = "2026-02-22T23:41:12.126Z";
const EMAIL_DATA_CREATED_AT = "2026-02-22T23:41:11.894Z";

const emailData = {
  broadcast_id: "8b146471-e88e-4322-86af-016cd36fd216",
  created_at: EMAIL_DATA_CREATED_AT,
  email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
  message_id: "<111-222-333@email.example.com>",
  from: "Acme <onboarding@resend.dev>",
  to: ["delivered@resend.dev"],
  subject: "Sending this example",
  template_id: "43f68331-0622-4e15-8202-246a0388854b",
  tags: {
    category: "confirm_email",
  },
};

function emailEnvelope(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    created_at: EMAIL_CREATED_AT,
    data: { ...emailData, ...extra },
  };
}

const domainCreated = {
  type: "domain.created",
  created_at: "2026-11-17T19:32:22.980Z",
  data: {
    id: "d91cd9bd-1176-453e-8fc1-35364d380206",
    name: "example.com",
    status: "not_started",
    created_at: "2026-04-26T20:21:26.347Z",
    region: "us-east-1",
    capabilities: {
      sending: "enabled",
      receiving: "disabled",
    },
    records: [
      {
        record: "SPF",
        name: "send",
        type: "MX",
        ttl: "Auto",
        status: "not_started",
        value: "feedback-smtp.us-east-1.amazonses.com",
        priority: 10,
      },
    ],
  },
};

const contactCreated = {
  type: "contact.created",
  created_at: "2026-11-17T19:32:22.980Z",
  data: {
    id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
    audience_id: "78261eea-8f8b-4381-83c6-79fa7120f1cf",
    segment_ids: ["78261eea-8f8b-4381-83c6-79fa7120f1cf"],
    created_at: "2026-11-17T19:32:22.980Z",
    updated_at: "2026-11-17T19:32:22.980Z",
    email: "steve.wozniak@gmail.com",
    first_name: null,
    last_name: null,
    unsubscribed: false,
  },
};

const suppressionAdded = {
  type: "suppression.added",
  created_at: "2026-11-17T19:32:22.980Z",
  data: {
    id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
    email: "steve.wozniak@gmail.com",
    origin: "bounce",
    source_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    created_at: "2026-11-17T19:32:22.980Z",
  },
};

export const resendWebhookFixtures = {
  "email.sent": emailEnvelope("email.sent"),
  "email.delivered": emailEnvelope("email.delivered"),
  "email.delivery_delayed": emailEnvelope("email.delivery_delayed"),
  "email.bounced": emailEnvelope("email.bounced", {
    bounce: {
      message:
        "The recipient's email address is on the suppression list because it has a recent history of producing hard bounces.",
      subType: "Suppressed",
      type: "Permanent",
      diagnosticCode: [
        "smtp; 550 5.5.0 Requested action not taken: mailbox unavailable",
      ],
    },
  }),
  "email.complained": emailEnvelope("email.complained"),
  "email.opened": emailEnvelope("email.opened"),
  "email.clicked": emailEnvelope("email.clicked", {
    click: {
      ipAddress: "122.115.53.11",
      link: "https://resend.com",
      timestamp: "2026-11-24T05:00:57.163Z",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
    },
  }),
  "email.failed": emailEnvelope("email.failed", {
    failed: { reason: "reached_daily_quota" },
  }),
  "email.scheduled": emailEnvelope("email.scheduled"),
  "email.suppressed": emailEnvelope("email.suppressed", {
    suppressed: {
      message: "The recipient's email address is on the suppression list.",
      type: "OnAccountSuppressionList",
    },
  }),
  "email.received": {
    type: "email.received",
    created_at: EMAIL_CREATED_AT,
    data: {
      email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      created_at: EMAIL_DATA_CREATED_AT,
      from: "onboarding@resend.dev",
      to: ["delivered@resend.dev"],
      bcc: [],
      cc: [],
      received_for: ["forwarded@example.com"],
      message_id: "<111-222-333@email.example.com>",
      subject: "Sending this example",
      attachments: [
        {
          id: "2a0c9ce0-3112-4728-976e-47ddcd16a318",
          filename: "avatar.png",
          content_type: "image/png",
          content_disposition: "inline",
          content_id: "img001",
        },
      ],
    },
  },
  "domain.created": domainCreated,
  "domain.updated": { ...domainCreated, type: "domain.updated" },
  "domain.deleted": { ...domainCreated, type: "domain.deleted" },
  "contact.created": contactCreated,
  "contact.updated": { ...contactCreated, type: "contact.updated" },
  "contact.deleted": { ...contactCreated, type: "contact.deleted" },
  "suppression.added": suppressionAdded,
  "suppression.removed": { ...suppressionAdded, type: "suppression.removed" },
} as const;
