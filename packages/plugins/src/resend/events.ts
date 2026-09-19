/**
 * The 19 Events Resend's webhook can raise, each a Workflow Graph Event on the
 * umbrella Inngest source `resend/webhook`.
 *
 * Identity is `resend/{type}` so the Lifecycle Node inspector lists one Event per thing
 * that happened. The listener filter is `source.when` on the envelope's `type`.
 * Payload is the Svix envelope `{ type, created_at, data }`. Extra keys pass
 * the intake gate; the structs below name the fields the editor offers.
 *
 * One rule decides every spelling here. A key is required where Resend's docs
 * and `resend-node`'s webhook types agree it is always sent, and
 * `Schema.optionalKey` where either source omits it or calls it conditional, as
 * the docs do for `template_id` with "(if applicable)". A field Resend documents
 * as an explicit null takes `NullOr` around whatever it holds. Where the sources
 * disagree the looser reading wins, because a refused payload never reaches
 * Resend: the POST was answered 200 at intake, so the refusal is visible only
 * to whoever reads the Inngest run history.
 *
 * The rule is worth following closely, since an optional key reaches the
 * condition picker as a nullable field, which is what offers a builder `is set`
 * and `is not set` on the path. Marking a field Resend always sends costs those
 * two operators their meaning.
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

/**
 * What every outbound `email.*` payload carries.
 *
 * Resend documents `broadcast_id` and `template_id` as "(if applicable)" and
 * types `tags` optional, so those three are the keys a run can arrive without.
 * The rest are on every documented example and non-optional in `resend-node`.
 */
const emailFields = {
  email_id: Schema.String,
  created_at: isoTimestampString("When the email was created"),
  from: Schema.String.annotate({ title: "Sender" }),
  to: Schema.mutable(Schema.Array(Schema.String)).annotate({
    title: "Recipients",
  }),
  subject: Schema.String,
  message_id: Schema.String.annotate({ title: "RFC Message-ID" }),
  broadcast_id: Schema.optionalKey(Schema.String),
  template_id: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      title: "Email tags",
    })
  ),
};

const emailData = Schema.Struct(emailFields);

/*
 * Each of the four per-event objects is required on its own event. `resend-node`
 * attaches it by intersection and the docs show it on every example, so both
 * sources agree, and one Event decodes one payload type: `defineEvent` compiles
 * `source.when` into an Inngest trigger filter, so `emailBouncedData` never
 * meets anything but an `email.bounced` payload.
 */

const emailClickedData = Schema.Struct({
  ...emailFields,
  click: Schema.Struct({
    ipAddress: Schema.String.annotate({ title: "Clicker IP address" }),
    link: Schema.String.annotate({ title: "Clicked URL" }),
    timestamp: isoTimestampString("When the link was clicked"),
    userAgent: Schema.String.annotate({ title: "Clicker user agent" }),
  }).annotate({ title: "Click tracking details" }),
});

const emailBouncedData = Schema.Struct({
  ...emailFields,
  bounce: Schema.Struct({
    message: Schema.String.annotate({ title: "Bounce message" }),
    subType: Schema.String.annotate({ title: "Bounce sub-type" }),
    type: Schema.String.annotate({ title: "Bounce type" }),
    // On the docs page and absent from `resend-node`'s bounce type, so the two
    // sources disagree and the looser reading wins.
    diagnosticCode: Schema.optionalKey(
      Schema.mutable(Schema.Array(Schema.String)).annotate({
        description: "Raw SMTP responses from the receiving server",
      })
    ),
  }).annotate({ title: "Bounce details" }),
});

const emailFailedData = Schema.Struct({
  ...emailFields,
  failed: Schema.Struct({
    reason: Schema.String.annotate({
      description: "Why sending failed",
    }),
  }).annotate({ title: "Failure details" }),
});

const emailSuppressedData = Schema.Struct({
  ...emailFields,
  suppressed: Schema.Struct({
    message: Schema.String.annotate({ title: "Suppression message" }),
    type: Schema.String.annotate({ title: "Suppression type" }),
  }).annotate({ title: "Suppression details" }),
});

/**
 * An inbound email, which carries its own set of keys.
 *
 * `resend-node` gives `email.received` its own payload type carrying the
 * addressing fields and the attachment metadata, with no `broadcast_id`,
 * `template_id` or `tags`, so this names its fields rather than spreading
 * `emailFields`.
 *
 * The received docs page does list those three, which looks like the source
 * disagreement the header rule resolves in favour of the looser reading. It is
 * a different question: that page renders the parameter list every email page
 * shares, and its own JSON example carries none of the three. Whether a key is
 * required is what the looser reading settles. Whether a path is declared at
 * all follows the evidence about this payload, and the example and the SDK
 * agree against the shared list.
 *
 * The body, the headers and the attachment contents are outside the payload;
 * Resend's Received emails and Attachments APIs are where those are read.
 */
const emailReceivedData = Schema.Struct({
  email_id: Schema.String,
  created_at: isoTimestampString("When the email was received"),
  from: Schema.String.annotate({
    title: "Sender",
    description: "The sender as a bare address with no display name.",
  }),
  to: Schema.mutable(Schema.Array(Schema.String)).annotate({
    title: "Recipients",
  }),
  cc: Schema.mutable(Schema.Array(Schema.String)).annotate({
    title: "CC recipients",
  }),
  bcc: Schema.mutable(Schema.Array(Schema.String)).annotate({
    title: "BCC recipients",
  }),
  received_for: Schema.mutable(Schema.Array(Schema.String)).annotate({
    title: "Received for",
    description: "Addresses the email was received for.",
  }),
  message_id: Schema.String.annotate({ title: "RFC Message-ID" }),
  subject: Schema.String,
  attachments: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String.annotate({ title: "Attachment ID" }),
        filename: Schema.NullOr(Schema.String),
        content_type: Schema.String,
        content_disposition: Schema.NullOr(Schema.String),
        content_id: Schema.NullOr(Schema.String),
      })
    )
  ).annotate({ title: "Attachment metadata" }),
});

const domainData = Schema.Struct({
  id: Schema.String.annotate({ title: "Domain ID" }),
  name: Schema.String.annotate({ title: "Domain name" }),
  status: Schema.String.annotate({ title: "Verification status" }),
  created_at: isoTimestampString("When the domain was created"),
  region: Schema.String.annotate({ title: "AWS region" }),
  // On the domain pages and absent from `resend-node`'s own domain payload
  // type, so the two sources disagree about whether it is always sent.
  capabilities: Schema.optionalKey(
    Schema.Struct({
      sending: Schema.String.annotate({ title: "Sending capability" }),
      receiving: Schema.String.annotate({ title: "Receiving capability" }),
    }).annotate({ title: "Domain capabilities" })
  ),
  records: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        record: Schema.String.annotate({ title: "Record purpose" }),
        name: Schema.String.annotate({ title: "DNS name" }),
        type: Schema.String.annotate({ title: "DNS type" }),
        value: Schema.String.annotate({ title: "DNS value" }),
        ttl: Schema.String,
        status: Schema.String.annotate({ title: "Record status" }),
        // Carried by an MX record alone, which the docs call optional.
        priority: Schema.optionalKey(
          Schema.Number.annotate({ title: "MX priority" })
        ),
      })
    )
  ).annotate({ title: "DNS records" }),
});

const contactData = Schema.Struct({
  id: Schema.String.annotate({ title: "Contact ID" }),
  // Not required per the docs and non-optional per `resend-node`.
  audience_id: Schema.optionalKey(Schema.String),
  segment_ids: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  created_at: isoTimestampString("When the contact was created"),
  updated_at: isoTimestampString("When the contact was last updated"),
  email: Schema.String.annotate({ title: "Contact email" }),
  // "May be absent from the payload" per the docs, and `string | null` in both
  // sources, so each field can go missing either way.
  first_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  last_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  unsubscribed: Schema.Boolean.annotate({
    title: "Unsubscribed from all emails",
  }),
});

const suppressionData = Schema.Struct({
  id: Schema.String.annotate({ title: "Suppression ID" }),
  email: Schema.String.annotate({ title: "Suppressed address" }),
  origin: Schema.Literals(["bounce", "complaint", "manual"]).annotate({
    description: "How the address was suppressed",
  }),
  // Null rather than absent when the origin is `manual`, which is the one place
  // Resend documents a null across the whole webhook surface.
  source_id: Schema.NullOr(Schema.String).annotate({
    description: "Email that triggered the suppression",
  }),
  created_at: isoTimestampString("When the suppression was created"),
});

function resendEnvelope<D extends Schema.Struct<Schema.Struct.Fields>>(
  data: D
) {
  return Schema.Struct({
    type: Schema.String.annotate({ title: "Resend event type" }),
    created_at: createdAt,
    data,
  });
}

/**
 * The payload shapes an `email.*` Event can carry.
 *
 * `defineEvent` takes a `PayloadSchema<JsonObject>`, and only the precise struct
 * proves the encoded side is JSON: widening this to
 * `Schema.Struct<Schema.Struct.Fields>` types `data` as an index signature of
 * `unknown` and fails that constraint. A new per-event shape is added here.
 */
type EmailDataSchema =
  | typeof emailData
  | typeof emailBouncedData
  | typeof emailClickedData
  | typeof emailFailedData
  | typeof emailSuppressedData
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

/** The same, for the Events correlated on `data.id`. */
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
    "Resend did not send the email because the address is suppressed.",
    emailSuppressedData
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
