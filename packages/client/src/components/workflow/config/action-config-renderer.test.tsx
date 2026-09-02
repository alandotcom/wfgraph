/**
 * What an empty field shows: the value the Connection would supply if the run
 * reached the handler with this field blank.
 *
 * Resend's From and Twilio's From Number are optional on the node and fall back
 * to a value stored on the Connection, so a blank box showing only a generic
 * example told a builder nothing about what the send would actually use. The
 * decision is `renderField`'s, so it is the same for every control: these cover
 * the template field, whose placeholder is a span inside a contenteditable, and
 * the plain text field, whose placeholder is a DOM attribute.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ActionConfigRenderer } from "#src/components/workflow/config/action-config-renderer";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";

const EXAMPLE = "Your Name <noreply@example.com>";
const STORED = "Support <support@example.com>";

const templateFrom: ActionConfigField = {
  key: "emailFrom",
  label: "From (Sender)",
  type: "template-input",
  placeholder: EXAMPLE,
  connectionDefaultKey: "RESEND_FROM_EMAIL",
};

const textFrom: ActionConfigField = {
  key: "textFrom",
  label: "From",
  type: "text",
  placeholder: EXAMPLE,
  connectionDefaultKey: "RESEND_FROM_EMAIL",
};

/** A field with no fallback declared, which must keep reading the catalog. */
const subject: ActionConfigField = {
  key: "emailSubject",
  label: "Subject",
  type: "template-input",
  placeholder: "Subject or {{NodeName.title}}",
};

function fieldsTree(input: {
  fields: readonly ActionConfigField[];
  connectionDefaults?: Record<string, string>;
  config?: Record<string, unknown>;
}) {
  return (
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      <ActionConfigRenderer
        config={input.config ?? {}}
        connectionDefaults={input.connectionDefaults}
        fields={input.fields}
        onUpdateConfig={() => undefined}
      />
    </ExtensionCatalogProvider>
  );
}

function renderFields(input: {
  fields: readonly ActionConfigField[];
  connectionDefaults?: Record<string, string>;
  config?: Record<string, unknown>;
}) {
  const { container, rerender } = render(
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      <ActionConfigRenderer
        config={input.config ?? {}}
        connectionDefaults={input.connectionDefaults}
        fields={input.fields}
        onUpdateConfig={() => undefined}
      />
    </ExtensionCatalogProvider>
  );

  return {
    templatePlaceholder: () =>
      container.querySelector("[data-placeholder]")?.textContent,
    attributePlaceholder: (key: string) =>
      container.querySelector(`#${key}`)?.getAttribute("placeholder"),
    withConnectionDefaults: (connectionDefaults: Record<string, string>) => {
      rerender(fieldsTree({ ...input, connectionDefaults }));
    },
  };
}

describe("a config field that falls back to a Connection value", () => {
  it("draws the Connection's stored value in a template field", () => {
    expect(
      renderFields({
        fields: [templateFrom],
        connectionDefaults: { RESEND_FROM_EMAIL: STORED },
      }).templatePlaceholder()
    ).toBe(STORED);
  });

  // The two controls carry a placeholder by different mechanisms, and the
  // decision is made once above both of them.
  it("draws the Connection's stored value in a plain text field", () => {
    expect(
      renderFields({
        fields: [textFrom],
        connectionDefaults: { RESEND_FROM_EMAIL: STORED },
      }).attributePlaceholder("textFrom")
    ).toBe(STORED);
  });

  it("falls back to the catalog example when the Connection holds nothing", () => {
    expect(
      renderFields({
        fields: [templateFrom],
        connectionDefaults: {},
      }).templatePlaceholder()
    ).toBe(EXAMPLE);
  });

  // A node pointing at a connection someone deleted, or at none yet: the panel
  // above resolves no record and the field keeps its example rather than going
  // blank.
  it("falls back to the catalog example when there is no Connection", () => {
    expect(renderFields({ fields: [templateFrom] }).templatePlaceholder()).toBe(
      EXAMPLE
    );
  });

  // The template control draws its placeholder imperatively into a
  // contenteditable, so a redraw keyed on the text alone would leave the old
  // hint on screen: picking a Connection changes the placeholder and nothing
  // else. This is what a builder actually does.
  it("follows the placeholder when a Connection is picked after the field drew", () => {
    const field = renderFields({ fields: [templateFrom] });
    expect(field.templatePlaceholder()).toBe(EXAMPLE);

    field.withConnectionDefaults({ RESEND_FROM_EMAIL: STORED });

    expect(field.templatePlaceholder()).toBe(STORED);
  });

  it("leaves a field that declared no fallback alone", () => {
    expect(
      renderFields({
        fields: [subject],
        connectionDefaults: { RESEND_FROM_EMAIL: STORED },
      }).templatePlaceholder()
    ).toBe("Subject or {{NodeName.title}}");
  });
});
