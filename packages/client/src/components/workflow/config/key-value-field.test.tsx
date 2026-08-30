/**
 * The key-value row: two compact inputs of one size. Mixing a short Name with a
 * tall template Value is what made the cells look like different controls.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionConfigRenderer } from "#src/components/workflow/config/action-config-renderer";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";

const propertiesField: ActionConfigField = {
  key: "properties",
  label: "Properties",
  type: "key-value",
};

function renderRow() {
  render(
    <ActionConfigRenderer
      config={{
        properties: JSON.stringify([{ name: "plan", value: "pro" }]),
      }}
      fields={[propertiesField]}
      onUpdateConfig={vi.fn()}
    />
  );
}

describe("a key-value row", () => {
  it("draws name and value as matching compact inputs", () => {
    renderRow();

    const name = screen.getByLabelText("Name");
    const value = screen.getByLabelText("Value");

    expect(name.tagName).toBe("INPUT");
    expect(value.tagName).toBe("INPUT");
    expect(name.className).toContain("h-7");
    expect(value.className).toContain("h-7");
    expect(name.className).toBe(value.className);
  });
});
