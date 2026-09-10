import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { LifecyclePanel } from "#src/components/workflow/config/lifecycle-panel";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const testCatalog: ExtensionCatalog = {
  entities: [],
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [{ path: "appointment.id", type: "string" }],
    },
    {
      name: "ops/nightly.swept",
      label: "Nightly sweep",
      payloadFields: [{ path: "sweep.id", type: "string" }],
    },
  ],
  actions: [],
  integrations: [],
};

const CONFIGURED: Record<string, unknown> = {
  lifecycleRules: {
    startEvents: ["app/appointment.created"],
    cancelEvents: ["ops/nightly.swept"],
    concurrency: "newest-wins",
    allowManualStart: true,
    correlationPaths: { "ops/nightly.swept": "sweep.id" },
  },
};

function ControlledPanel() {
  const [config, setConfig] = useState(CONFIGURED);
  return (
    <LifecyclePanel
      config={config}
      disabled={false}
      onUpdateConfig={(patch) =>
        setConfig((current) => ({ ...current, ...patch }))
      }
    />
  );
}

function renderPanel(ui = <ControlledPanel />) {
  return render(
    <ExtensionCatalogProvider value={testCatalog}>
      {ui}
    </ExtensionCatalogProvider>
  );
}

describe("LifecyclePanel display", () => {
  it("shows the stored configuration in the controls that set it", () => {
    const view = renderPanel();

    expect(view.getByLabelText("Start Events")).toBeTruthy();
    expect(view.getByLabelText("Cancel Events")).toBeTruthy();
    expect(
      view.getByRole("combobox", { name: "Overlapping runs" }).textContent
    ).toContain("Start the newest run");
    expect(
      view.getByRole("checkbox", { name: "Allow manual runs" })
    ).toBeTruthy();
    expect(
      view.getByRole("heading", { name: "Appointment created" })
    ).toBeTruthy();
    expect(view.getByRole("heading", { name: "Nightly sweep" })).toBeTruthy();
  });

  it("offers no button that switches the panel's mode", () => {
    const view = renderPanel();

    expect(view.queryAllByRole("button", { name: /^Edit / })).toEqual([]);
    expect(view.queryAllByRole("button", { name: /^Done editing / })).toEqual(
      []
    );
  });

  it("disables every control on a disabled panel", () => {
    const view = renderPanel(
      <LifecyclePanel config={CONFIGURED} disabled onUpdateConfig={vi.fn()} />
    );

    // A non-owner still reads what the rules are, and every way of changing
    // them is refused where it stands rather than hidden.
    expect(
      view
        .getByRole("combobox", { name: "Overlapping runs" })
        .hasAttribute("disabled")
    ).toBe(true);
    // Base UI draws this one as a span rather than a control the browser can
    // disable, so the refusal is carried by aria-disabled.
    expect(
      view
        .getByRole("checkbox", { name: "Allow manual runs" })
        .getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      view
        .getByRole("button", { name: "Remove ops/nightly.swept" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("opens a section's help on a click", () => {
    const view = renderPanel();

    expect(
      view.queryByText(/A run starts when one of these events/)
    ).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "About Start Events" }));
    expect(
      view.getByText(/A run starts when one of these events/)
    ).toBeTruthy();
  });

  it("puts the concurrency setting in force at the top of its help", () => {
    const view = renderPanel();

    fireEvent.click(
      view.getByRole("button", { name: "About Overlapping runs" })
    );
    const described = view
      .getAllByText(
        /End matching active runs, then start the new run|Each event starts a separate run/
      )
      .map((node) => node.textContent ?? "");
    expect(described.at(0)).toContain(
      "End matching active runs, then start the new run"
    );
  });

  it("shows the selected overlap outcome and keeps alternatives and manual-run details in help", () => {
    const view = renderPanel();

    expect(
      view.getByText(/End matching active runs, then start the new run/)
    ).toBeTruthy();
    expect(view.queryByText(/Each event starts a separate run/)).toBeNull();
    expect(view.queryByText(/The editor and execute API/)).toBeNull();

    fireEvent.click(
      view.getByRole("button", { name: "About Overlapping runs" })
    );
    expect(view.getByText(/Each event starts a separate run/)).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "About Allow manual runs" })
    );
    expect(view.getByText(/The editor and execute API/)).toBeTruthy();
  });
});
