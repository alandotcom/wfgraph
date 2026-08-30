/**
 * The key-value row: two cells of one control, not a compact name beside a
 * template value. Mixing those is what made Name a short pill and Value a
 * taller box.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionConfigRenderer } from "#src/components/workflow/config/action-config-renderer";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";

const propertiesField: ActionConfigField = {
  key: "properties",
  label: "Properties",
  type: "key-value",
};

function renderRow() {
  render(
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      <ActionConfigRenderer
        config={{
          properties: JSON.stringify([{ name: "plan", value: "pro" }]),
        }}
        fields={[propertiesField]}
        onUpdateConfig={vi.fn()}
      />
    </ExtensionCatalogProvider>
  );
}

function chromeOf(label: string): HTMLElement {
  const field = screen.getByLabelText(label);
  const chrome = field.parentElement;
  if (!chrome) {
    throw new Error(`no chrome around ${label}`);
  }
  return chrome;
}

describe("a key-value row", () => {
  it("draws name and value with the same template-input chrome", () => {
    renderRow();

    const name = chromeOf("Name");
    const value = chromeOf("Value");

    expect(name.className).toContain("min-h-9");
    expect(value.className).toContain("min-h-9");
    expect(name.className).toBe(value.className);
  });
});
