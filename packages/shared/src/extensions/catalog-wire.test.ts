import { describe, expect, it } from "vitest";
import { readExtensionCatalog } from "#src/extensions/catalog-wire";
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

  it("carries both string formats across the wire", () => {
    const payloadFields: ReferenceField[] = [
      { path: "startsAt", type: "timestamp" },
      { path: "leadTime", type: "duration" },
    ];

    expect(readExtensionCatalog(aCatalog(payloadFields))).toEqual(
      aCatalog(payloadFields)
    );
  });

  it("carries showWhen on a reference field across the wire", () => {
    const payloadFields: ReferenceField[] = [
      {
        path: "event",
        type: "string",
        showWhen: { field: "waitMode", equals: "event" },
      },
    ];

    expect(readExtensionCatalog(aCatalog(payloadFields))).toEqual(
      aCatalog(payloadFields)
    );
  });

  // The editor keeps a send outside a Group frame, and this flag is the only
  // thing that tells it which action is one. Dropped on the wire, every send
  // would look like a lookup to the browser.
  it("carries an action's side effect across the wire", () => {
    const catalog: ExtensionCatalog = {
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
      events: [],
      actions: [],
      integrations: [
        {
          type: "resend",
          label: "Resend",
          description: "Sends email",
          credentialFields: {},
          hasTest: true,
          oauth: { label: "Connect with Resend" },
        },
      ],
    };

    expect(readExtensionCatalog(catalog)).toEqual(catalog);
  });

  it("answers nothing for a field type the vocabulary has no word for", () => {
    expect(
      readExtensionCatalog(aCatalog([{ path: "x", type: "money" } as never]))
    ).toBeUndefined();
  });
});
