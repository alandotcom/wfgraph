/**
 * The 19 Events Resend's webhook can raise, each a Workflow Graph Event on the
 * umbrella Inngest source `resend/webhook`.
 *
 * Identity is `resend/{type}` so the Lifecycle panel lists one Event per thing
 * that happened. The listener filter is `source.when` on the envelope's `type`.
 * Payload is the Svix envelope `{ type, created_at, data }`. Extra keys pass
 * the intake gate; the structs below name the fields the editor offers.
 */

import { defineEvent, isoTimestampString } from "@wfgraph/core/plugin";
import { Schema } from "effect";

export const RESEND_WEBHOOK_SOURCE = "resend/webhook";

export const RESEND_WEBHOOK_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.scheduled",
  "email.suppressed",
  "email.received",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "suppression.added",
  "suppression.removed",
] as const;

export type ResendWebhookEventType =
  (typeof RESEND_WEBHOOK_EVENT_TYPES)[number];

const createdAt = isoTimestampString("When Resend created this Event");

const emailFields = {
  email_id: Schema.String.annotate({ description: "Email ID" }),
  created_at: Schema.optionalKey(
    isoTimestampString("When the email was created")
  ),
  from: Schema.optionalKey(Schema.String.annotate({ description: "Sender" })),
  to: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Recipients",
    })
  ),
  subject: Schema.optionalKey(
    Schema.String.annotate({ description: "Subject" })
  ),
  broadcast_id: Schema.optionalKey(
    Schema.String.annotate({ description: "Broadcast ID" })
  ),
  message_id: Schema.optionalKey(
    Schema.String.annotate({ description: "RFC Message-ID" })
  ),
  template_id: Schema.optionalKey(
    Schema.String.annotate({ description: "Template ID" })
  ),
  tags: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Email tags",
    })
  ),
};

const emailData = Schema.Struct(emailFields);

const emailClickedData = Schema.Struct({
  ...emailFields,
  click: Schema.optionalKey(
    Schema.Struct({
      ipAddress: Schema.optionalKey(
        Schema.String.annotate({ description: "Clicker IP address" })
      ),
      link: Schema.optionalKey(
        Schema.String.annotate({ description: "Clicked URL" })
      ),
      timestamp: Schema.optionalKey(
        isoTimestampString("When the link was clicked")
      ),
      userAgent: Schema.optionalKey(
        Schema.String.annotate({ description: "Clicker user agent" })
      ),
    }).annotate({ description: "Click tracking details" })
  ),
});

const emailBouncedData = Schema.Struct({
  ...emailFields,
  bounce: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(
        Schema.String.annotate({ description: "Bounce message" })
      ),
      subType: Schema.optionalKey(
        Schema.String.annotate({ description: "Bounce sub-type" })
      ),
      type: Schema.optionalKey(
        Schema.String.annotate({ description: "Bounce type" })
      ),
    }).annotate({ description: "Bounce details" })
  ),
});

const emailFailedData = Schema.Struct({
  ...emailFields,
  failed: Schema.optionalKey(
    Schema.Struct({
      reason: Schema.optionalKey(
        Schema.String.annotate({ description: "Why sending failed" })
      ),
    }).annotate({ description: "Failure details" })
  ),
});

const emailReceivedData = Schema.Struct({
  ...emailFields,
  cc: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "CC recipients",
    })
  ),
  bcc: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "BCC recipients",
    })
  ),
  received_for: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Addresses the email was received for",
    })
  ),
  attachments: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          id: Schema.optionalKey(
            Schema.String.annotate({ description: "Attachment ID" })
          ),
          filename: Schema.optionalKey(
            Schema.String.annotate({ description: "Filename" })
          ),
          content_type: Schema.optionalKey(
            Schema.String.annotate({ description: "Content type" })
          ),
          content_disposition: Schema.optionalKey(
            Schema.String.annotate({ description: "Content disposition" })
          ),
          content_id: Schema.optionalKey(
            Schema.String.annotate({ description: "Content ID" })
          ),
        })
      )
    ).annotate({ description: "Attachment metadata" })
  ),
});

const domainData = Schema.Struct({
  id: Schema.String.annotate({ description: "Domain ID" }),
  name: Schema.optionalKey(
    Schema.String.annotate({ description: "Domain name" })
  ),
  status: Schema.optionalKey(
    Schema.String.annotate({ description: "Verification status" })
  ),
  created_at: Schema.optionalKey(
    isoTimestampString("When the domain was created")
  ),
  region: Schema.optionalKey(
    Schema.String.annotate({ description: "AWS region" })
  ),
  capabilities: Schema.optionalKey(
    Schema.Struct({
      sending: Schema.optionalKey(
        Schema.String.annotate({ description: "Sending capability" })
      ),
      receiving: Schema.optionalKey(
        Schema.String.annotate({ description: "Receiving capability" })
      ),
    }).annotate({ description: "Domain capabilities" })
  ),
  records: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          record: Schema.optionalKey(
            Schema.String.annotate({ description: "Record purpose" })
          ),
          name: Schema.optionalKey(
            Schema.String.annotate({ description: "DNS name" })
          ),
          type: Schema.optionalKey(
            Schema.String.annotate({ description: "DNS type" })
          ),
          value: Schema.optionalKey(
            Schema.String.annotate({ description: "DNS value" })
          ),
          ttl: Schema.optionalKey(
            Schema.String.annotate({ description: "TTL" })
          ),
          status: Schema.optionalKey(
            Schema.String.annotate({ description: "Record status" })
          ),
          priority: Schema.optionalKey(
            Schema.Number.annotate({ description: "MX priority" })
          ),
        })
      )
    ).annotate({ description: "DNS records" })
  ),
});

const contactData = Schema.Struct({
  id: Schema.String.annotate({ description: "Contact ID" }),
  audience_id: Schema.optionalKey(
    Schema.String.annotate({ description: "Audience ID" })
  ),
  segment_ids: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Segment IDs",
    })
  ),
  created_at: Schema.optionalKey(
    isoTimestampString("When the contact was created")
  ),
  updated_at: Schema.optionalKey(
    isoTimestampString("When the contact was last updated")
  ),
  email: Schema.optionalKey(
    Schema.String.annotate({ description: "Contact email" })
  ),
  first_name: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({ description: "First name" })
  ),
  last_name: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({ description: "Last name" })
  ),
  unsubscribed: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Unsubscribed from all emails" })
  ),
});

const suppressionData = Schema.Struct({
  id: Schema.String.annotate({ description: "Suppression ID" }),
  email: Schema.optionalKey(
    Schema.String.annotate({ description: "Suppressed address" })
  ),
  origin: Schema.optionalKey(
    Schema.String.annotate({
      description: "How the address was suppressed",
    })
  ),
  source_id: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "Email that triggered the suppression",
    })
  ),
  created_at: Schema.optionalKey(
    isoTimestampString("When the suppression was created")
  ),
});

function resendEnvelope<D extends Schema.Struct<Schema.Struct.Fields>>(
  data: D
) {
  return Schema.Struct({
    type: Schema.String.annotate({ description: "Resend event type" }),
    created_at: createdAt,
    data,
  });
}

type EmailDataSchema =
  | typeof emailData
  | typeof emailBouncedData
  | typeof emailClickedData
  | typeof emailFailedData
  | typeof emailReceivedData;

function emailEvent(
  type: string,
  label: string,
  description: string,
  data: EmailDataSchema = emailData
) {
  return defineEvent({
    name: `resend/${type}`,
    label,
    description,
    schema: resendEnvelope(data),
    correlationPath: "data.email_id",
    source: {
      event: RESEND_WEBHOOK_SOURCE,
      when: { path: "type", equals: type },
    },
  });
}

type IdDataSchema =
  | typeof domainData
  | typeof contactData
  | typeof suppressionData;

function idEvent(
  type: string,
  label: string,
  description: string,
  data: IdDataSchema
) {
  return defineEvent({
    name: `resend/${type}`,
    label,
    description,
    schema: resendEnvelope(data),
    correlationPath: "data.id",
    source: {
      event: RESEND_WEBHOOK_SOURCE,
      when: { path: "type", equals: type },
    },
  });
}

export const resendEvents = [
  emailEvent(
    "email.sent",
    "Email sent",
    "Resend accepted the email and queued it for delivery."
  ),
  emailEvent(
    "email.delivered",
    "Email delivered",
    "The recipient's mail server accepted the email."
  ),
  emailEvent(
    "email.delivery_delayed",
    "Email delivery delayed",
    "Delivery was delayed by a temporary issue at the receiving server."
  ),
  emailEvent(
    "email.bounced",
    "Email bounced",
    "The recipient's mail server permanently rejected the email.",
    emailBouncedData
  ),
  emailEvent(
    "email.complained",
    "Email complained",
    "The recipient marked the email as spam."
  ),
  emailEvent("email.opened", "Email opened", "The recipient opened the email."),
  emailEvent(
    "email.clicked",
    "Email clicked",
    "The recipient clicked a link in the email.",
    emailClickedData
  ),
  emailEvent(
    "email.failed",
    "Email failed",
    "Resend could not send the email.",
    emailFailedData
  ),
  emailEvent(
    "email.scheduled",
    "Email scheduled",
    "The email was scheduled for later sending."
  ),
  emailEvent(
    "email.suppressed",
    "Email suppressed",
    "Resend did not send the email because the address is suppressed."
  ),
  emailEvent(
    "email.received",
    "Email received",
    "Resend received an inbound email. The body is not in the payload.",
    emailReceivedData
  ),
  idEvent(
    "domain.created",
    "Domain created",
    "A sending or receiving domain was created.",
    domainData
  ),
  idEvent(
    "domain.updated",
    "Domain updated",
    "A domain's records or status changed.",
    domainData
  ),
  idEvent(
    "domain.deleted",
    "Domain deleted",
    "A domain was deleted.",
    domainData
  ),
  idEvent(
    "contact.created",
    "Contact created",
    "A contact was created in an audience.",
    contactData
  ),
  idEvent(
    "contact.updated",
    "Contact updated",
    "A contact was updated.",
    contactData
  ),
  idEvent(
    "contact.deleted",
    "Contact deleted",
    "A contact was deleted.",
    contactData
  ),
  idEvent(
    "suppression.added",
    "Suppression added",
    "An address was added to the suppression list.",
    suppressionData
  ),
  idEvent(
    "suppression.removed",
    "Suppression removed",
    "An address was removed from the suppression list.",
    suppressionData
  ),
] as const;
