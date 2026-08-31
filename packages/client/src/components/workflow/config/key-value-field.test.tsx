/**
 * The key-value row: a plain Name box beside a template-capable Value box, drawn
 * to one height. Mixing a short Name with a tall template Value is what made the
 * cells look like different controls.
 *
 * The Value carries templates because a tag or a property is usually about the
 * run it belongs to. The Name does not: it is the key of whatever the step
 * builds, and the systems that take one hold it to a short alphabet.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { ActionConfigRenderer } from "#src/components/workflow/config/action-config-renderer";
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

describe("a key-value row", () => {
  it("draws the name as a plain input and the value as a template control", () => {
    renderRow();

    const name = screen.getByLabelText("Name");
    const value = screen.getByLabelText("Value");

    expect(name.tagName).toBe("INPUT");
    expect(name.className).toContain("h-7");
    expect(value.getAttribute("role")).toBe("textbox");
    expect(value.getAttribute("contenteditable")).toBe("true");
  });

  it("holds the value box to the height of the name box beside it", () => {
    renderRow();

    const chrome = screen.getByLabelText("Value").parentElement;
    expect(chrome?.className).toContain("min-h-7");
    expect(chrome?.className).not.toContain("min-h-9");
  });

  it("shows the stored row", () => {
    renderRow();

    expect(screen.getByLabelText("Name").getAttribute("value")).toBe("plan");
    expect(screen.getByLabelText("Value").textContent).toBe("pro");
  });
});
