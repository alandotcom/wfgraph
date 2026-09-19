import { requireOutputFieldsFromSchema } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { resend } from "#src/resend/index";

const integration = resend;

/**
 * What a node downstream of a Send Email node can reference.
 *
 * The one path the hand-written list carried keeps its exact description, and
 * `reasonCode` -- which a test run has always answered with and never offered
 * -- is here too.
 */
describe("the resend integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(integration.type).toBe("resend");
    expect(integration.test).toBeDefined();
    expect(Object.keys(integration.credentials)).toEqual([
      "RESEND_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
    ]);
    expect(integration.events?.map((event) => event.name)).toContain(
      "resend/email.delivered"
    );
    expect(integration.webhook).toBeDefined();
    expect(integration.webhook?.secret).toBe("RESEND_WEBHOOK_SECRET");
    expect(Object.keys(integration.actions)).toEqual([
      "send-email",
      "find-email",
    ]);
  });

  it("declares Resend's provider-owned OAuth adapter", () => {
    expect(integration.oauth).toBeDefined();
    expect(integration.oauth?.label).toBe("Resend");
    expect(integration.oauth?.pkce).toBe("S256");
  });

  it("wires both template fields to a provider that answers their kind", () => {
    expect(Object.keys(integration.configOptions ?? {})).toEqual([
      "templates",
      "template-variables",
    ]);
    expect(integration.configOptions?.templates?.answers).toBe("options");
    expect(integration.configOptions?.["template-variables"]?.answers).toBe(
      "fields"
    );

    const fields = integration.actions["send-email"].configFields ?? [];
    const templateField = fields.find(
      (field) => "key" in field && field.key === "emailTemplateId"
    );
    const variablesField = fields.find(
      (field) => "key" in field && field.key === "emailTemplateVariables"
    );

    expect(templateField).toMatchObject({
      type: "provider-select",
      optionsSource: { provider: "templates" },
    });
    // The variables question is parameterised by the template, so the picker
    // above has to be answered before this one can be asked.
    expect(variablesField).toMatchObject({
      type: "provider-fields",
      optionsSource: {
        provider: "template-variables",
        parameters: ["emailTemplateId"],
      },
    });
  });

  it("offers every field the step returns, described by the schema", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "resend/send-email"',
        integration.actions["send-email"].output
      )
    ).toEqual([
      { path: "id", label: "Email ID", type: "string" },
      {
        path: "reasonCode",
        description: "Why a test run did not send",
        type: "string",
        nullable: true,
      },
      // An open record, so the editor lists the record and offers a key under it
      // by name. That is the same entry a `resend/email.*` payload carries, and
      // the two agreeing is what lets one workflow tag a send and the next read
      // the tag off the webhook.
      // Nullable because a send that carried no tags omits the key entirely,
      // which is what offers a downstream rule `is set` on the record.
      {
        path: "tags",
        label: "Email tags",
        type: "object",
        valueType: "string",
        nullable: true,
      },
    ]);
  });

  it("offers every field returned by find-email", () => {
    expect(
      requireOutputFieldsFromSchema(
        'Action "resend/find-email"',
        integration.actions["find-email"].output
      )
    ).toEqual([
      { path: "id", label: "Email ID", type: "string" },
      { path: "messageId", label: "Provider message ID", type: "string" },
      { path: "from", label: "Sender", type: "string" },
      { path: "to", label: "Recipients", type: "array" },
      {
        path: "cc",
        label: "CC recipients",
        type: "array",
        nullable: true,
      },
      {
        path: "bcc",
        label: "BCC recipients",
        type: "array",
        nullable: true,
      },
      {
        path: "replyTo",
        label: "Reply-to addresses",
        type: "array",
        nullable: true,
      },
      { path: "subject", label: "Email subject", type: "string" },
      {
        path: "html",
        label: "HTML body",
        type: "string",
        nullable: true,
      },
      {
        path: "text",
        label: "Plain-text body",
        type: "string",
        nullable: true,
      },
      {
        path: "createdAt",
        description: "When the email was created",
        type: "timestamp",
      },
      { path: "lastEvent", label: "Latest email event", type: "string" },
      {
        path: "scheduledAt",
        description: "When the email was scheduled to send",
        type: "timestamp",
        nullable: true,
      },
      {
        path: "tags",
        label: "Email tags",
        type: "object",
        valueType: "string",
        nullable: true,
      },
    ]);
  });
});
