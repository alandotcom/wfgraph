import { describe, expect, it } from "vitest";
import {
  readExtensionCatalog,
  readExtensionsResponse,
} from "#src/extensions/catalog-wire";
import { WfGraphOperations } from "#src/authorization/operations";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import type { ReferenceField } from "#src/graph/node-references";
import type { WorkflowSchemaFieldType } from "#src/graph/schema-codec";

/** Every field type an Event Author can declare, one Event carrying all of them. */
const EVERY_FIELD_TYPE: WorkflowSchemaFieldType[] = [
  "string",
  "number",
  "boolean",
  "timestamp",
  "duration",
  "array",
  "object",
];

function aCatalog(payloadFields: ReferenceField[]): ExtensionCatalog {
  return {
    events: [{ name: "app/thing.happened", label: "Thing", payloadFields }],
    entities: [],
    actions: [],
    integrations: [],
  };
}

describe("readExtensionCatalog", () => {
  // The decode is all-or-nothing, so one field type this schema leaves out costs
  // the editor the whole surface rather than that one field. The type list is
  // the source of truth; this is what holds the wire to it.
  it("carries every declarable field type across the wire", () => {
    const payloadFields = EVERY_FIELD_TYPE.map((type) => ({
      path: type,
      type,
    }));

    expect(readExtensionCatalog(aCatalog(payloadFields))).toEqual(
      aCatalog(payloadFields)
    );
  });

  it("carries field labels, descriptions, enums, and string formats across the wire", () => {
    const payloadFields: ReferenceField[] = [
      {
        path: "startsAt",
        label: "Starts at",
        description: "When the appointment starts",
        type: "timestamp",
      },
      {
        path: "status",
        type: "string",
        enumValues: ["InProgress", "NeedsReview"],
        enumLabels: {
          InProgress: "In progress",
          NeedsReview: "Needs review",
        },
      },
      { path: "leadTime", type: "duration" },
    ];

    expect(readExtensionCatalog(aCatalog(payloadFields))).toEqual(
      aCatalog(payloadFields)
    );
  });

  // Without this the editor cannot tell an open record from an empty object, and
  // a builder loses every path under it.
  it("carries an open record's value type across the wire", () => {
    const payloadFields: ReferenceField[] = [
      { path: "data.tags", type: "object", valueType: "string" },
    ];

    expect(readExtensionCatalog(aCatalog(payloadFields))).toEqual(
      aCatalog(payloadFields)
    );
  });

  it("carries authoring visibility on a reference field across the wire", () => {
    const payloadFields: ReferenceField[] = [
      {
        path: "event",
        type: "string",
        showWhen: { field: "waitMode", equals: "event" },
        hidden: true,
      },
    ];

    expect(readExtensionCatalog(aCatalog(payloadFields))).toEqual(
      aCatalog(payloadFields)
    );
  });

  it("carries list visibility on config and output fields across JSON", () => {
    const showWhen = { field: "template", in: ["a", "b"] as const };
    const catalog: ExtensionCatalog = {
      ...aCatalog([]),
      actions: [
        {
          id: "host/template",
          label: "Template",
          description: "Uses a template",
          category: "Custom",
          configFields: [
            { key: "name", label: "Name", type: "text", showWhen },
          ],
          outputFields: [{ path: "name", type: "string", showWhen }],
        },
      ],
    };

    expect(readExtensionCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(
      catalog
    );
  });

  it.each([
    { field: "template", equals: "a", in: ["a", "b"] },
    { field: "template" },
    { field: "template", in: "a" },
    { field: "template", in: [1] },
    { field: "constructor", in: ["a"] },
  ])("refuses an invalid visibility condition %j", (showWhen) => {
    const catalog = {
      ...aCatalog([]),
      actions: [
        {
          id: "host/template",
          label: "Template",
          description: "Uses a template",
          category: "Custom",
          configFields: [
            { key: "name", label: "Name", type: "text", showWhen },
          ],
          outputFields: [],
        },
      ],
    };
    expect(readExtensionCatalog(catalog)).toBeUndefined();
    expect(
      readExtensionCatalog({
        ...aCatalog([]),
        events: [
          {
            name: "app/thing.happened",
            label: "Thing",
            payloadFields: [{ path: "name", type: "string", showWhen }],
          },
        ],
      })
    ).toBeUndefined();
  });

  // The editor keeps a send outside a Group frame, and this flag is the only
  // thing that tells it which action is one. Dropped on the wire, every send
  // would look like a lookup to the browser.
  it("carries an action's side effect across the wire", () => {
    const catalog: ExtensionCatalog = {
      entities: [],
      events: [],
      actions: [
        {
          id: "resend/send-email",
          label: "Send Email",
          description: "Sends an email",
          category: "Resend",
          sideEffect: true,
          configFields: [],
          outputFields: [],
        },
      ],
      integrations: [],
    };

    expect(readExtensionCatalog(catalog)).toEqual(catalog);
  });

  it("carries sanitized OAuth capability metadata across the wire", () => {
    const catalog: ExtensionCatalog = {
      entities: [],
      events: [],
      actions: [],
      integrations: [
        {
          type: "resend",
          label: "Resend",
          description: "Sends email",
          credentialFields: {},
          hasTest: true,
          hasWebhook: false,
          oauth: { label: "Connect with Resend" },
        },
      ],
    };

    expect(readExtensionCatalog(catalog)).toEqual(catalog);
  });

  it("carries Entity metadata and Event bindings across the wire", () => {
    const catalog: ExtensionCatalog = {
      entities: [
        {
          type: "appointment",
          label: "Appointment",
          stateFields: [
            { path: "status", type: "string" },
            { path: "startsAt", type: "timestamp" },
          ],
          stateSchemaDigest: "abc123",
        },
      ],
      events: [
        {
          name: "app/appointment.created",
          label: "Appointment created",
          payloadFields: [{ path: "appointmentId", type: "string" }],
          entityBindings: [{ name: "appointment", entityType: "appointment" }],
        },
      ],
      actions: [],
      integrations: [],
    };

    expect(readExtensionCatalog(catalog)).toEqual(catalog);
  });

  it("carries Event ownership and webhook capability across the wire", () => {
    const catalog: ExtensionCatalog = {
      entities: [],
      events: [
        {
          name: "resend/email.delivered",
          label: "Email delivered",
          integration: "resend",
          correlationPath: "data.email_id",
          payloadFields: [{ path: "data.email_id", type: "string" }],
        },
      ],
      actions: [],
      integrations: [
        {
          type: "resend",
          label: "Resend",
          description: "Sends email",
          credentialFields: {},
          hasTest: true,
          hasWebhook: true,
          webhookHelpText:
            "Create a webhook in Resend with all event types selected, then paste this URL and the signing secret from that page.",
          webhookSecretKey: "RESEND_WEBHOOK_SECRET",
        },
      ],
    };

    expect(readExtensionCatalog(catalog)).toEqual(catalog);
  });

  it("carries a provider-backed field's optionsSource across the wire", () => {
    const catalog: ExtensionCatalog = {
      entities: [],
      events: [],
      actions: [
        {
          id: "resend/send-email",
          label: "Send Email",
          description: "Sends an email",
          category: "Resend",
          integration: "resend",
          sideEffect: true,
          configFields: [
            {
              key: "emailTemplateId",
              label: "Template",
              description: "Choose the template to send.",
              type: "provider-select",
              optionsSource: { provider: "templates" },
            },
            {
              key: "emailTemplateVariables",
              label: "Template Variables",
              type: "provider-fields",
              optionsSource: {
                provider: "template-variables",
                parameters: ["emailTemplateId"],
              },
            },
          ],
          outputFields: [],
        },
      ],
      integrations: [],
    };

    expect(readExtensionCatalog(catalog)).toEqual(catalog);
  });

  it("carries a field's connectionDefaultKey across the wire", () => {
    const catalog: ExtensionCatalog = {
      entities: [],
      events: [],
      actions: [
        {
          id: "resend/send-email",
          label: "Send Email",
          description: "Sends an email",
          category: "Resend",
          integration: "resend",
          configFields: [
            {
              key: "emailFrom",
              label: "From (Sender)",
              type: "template-input",
              connectionDefaultKey: "RESEND_FROM_EMAIL",
            },
          ],
          outputFields: [],
        },
      ],
      integrations: [],
    };

    expect(readExtensionCatalog(catalog)).toEqual(catalog);
  });

  it("refuses a reserved config field key on the wire", () => {
    const catalog: ExtensionCatalog = {
      entities: [],
      events: [],
      actions: [
        {
          id: "resend/send-email",
          label: "Send Email",
          description: "Sends an email",
          category: "Resend",
          configFields: [{ key: "constructor", label: "Unsafe", type: "text" }],
          outputFields: [],
        },
      ],
      integrations: [],
    };

    expect(readExtensionCatalog(catalog)).toBeUndefined();
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "refuses the reserved credential name %s on the wire",
    (key) => {
      const catalog: ExtensionCatalog = {
        entities: [],
        events: [],
        actions: [],
        integrations: [
          {
            type: "example",
            label: "Example",
            description: "Unsafe credential",
            credentialFields: Object.fromEntries([
              [key, { label: "Unsafe", type: "text" }],
            ]),
            hasTest: false,
            hasWebhook: false,
          },
        ],
      };

      expect(readExtensionCatalog(catalog)).toBeUndefined();
    }
  );

  it("refuses a reserved object-path segment on the wire", () => {
    expect(
      readExtensionCatalog(
        aCatalog([{ path: "event.__proto__.polluted", type: "string" }])
      )
    ).toBeUndefined();
  });

  it("answers nothing for a field type the vocabulary has no word for", () => {
    expect(
      readExtensionCatalog(aCatalog([{ path: "x", type: "money" } as never]))
    ).toBeUndefined();
  });
});

describe("readExtensionsResponse", () => {
  const envelope = {
    catalog: { events: [], entities: [], actions: [], integrations: [] },
    agent: { enabled: false },
    authorization: {
      operationIds: [
        WfGraphOperations.workflowGetAll.id,
        WfGraphOperations.workflowCreate.id,
      ],
    },
  };

  it("requires the boot authorization snapshot", () => {
    const { authorization: _authorization, ...missingAuthorization } = envelope;

    expect(readExtensionsResponse(missingAuthorization)).toBeUndefined();
  });

  it("accepts canonical operation IDs in their supplied order", () => {
    expect(
      readExtensionsResponse(envelope)?.authorization.operationIds
    ).toEqual(envelope.authorization.operationIds);
  });

  it("refuses an unknown operation ID", () => {
    expect(
      readExtensionsResponse({
        ...envelope,
        authorization: { operationIds: ["workflow.unknown"] },
      })
    ).toBeUndefined();
  });
});
