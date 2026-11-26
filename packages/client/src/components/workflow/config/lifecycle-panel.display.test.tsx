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

    expect(view.getByLabelText("Starts when")).toBeTruthy();
    expect(view.getByLabelText("Stop a run when")).toBeTruthy();
    expect(
      view.getByRole("combobox", { name: "If a run is already in progress" })
        .textContent
    ).toContain("Start the newest run");
    expect(
      view.getByRole("checkbox", { name: "Can be run by hand" })
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
        .getByRole("combobox", { name: "If a run is already in progress" })
        .hasAttribute("disabled")
    ).toBe(true);
    // Base UI draws this one as a span rather than a control the browser can
    // disable, so the refusal is carried by aria-disabled.
    expect(
      view
        .getByRole("checkbox", { name: "Can be run by hand" })
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

    expect(view.queryByText(/Each arrival of a Start Event starts a run/)).toBe(
      null
    );
    fireEvent.click(view.getByRole("button", { name: "About Starts when" }));
    expect(
      view.getByText(/Each arrival of a Start Event starts a run/)
    ).toBeTruthy();
  });

  it("puts the concurrency setting in force at the top of its help", () => {
    const view = renderPanel();

    fireEvent.click(
      view.getByRole("button", {
        name: "About If a run is already in progress",
      })
    );
    const described = view
      .getAllByText(
        /End related active runs, then start the new run|Each arrival starts a separate run/
      )
      .map((node) => node.textContent ?? "");
    expect(described.at(0)).toContain(
      "End related active runs, then start the new run"
    );
  });

  it("explains how overlap rules relate manual-only runs", () => {
    const view = renderPanel(
      <LifecyclePanel
        config={{
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "first-wins",
            allowManualStart: true,
          },
        }}
        disabled={false}
        onUpdateConfig={vi.fn()}
      />
    );

    fireEvent.click(
      view.getByRole("button", {
        name: "About If a run is already in progress",
      })
    );
    expect(
      view.getByText(
        "With no start or Cancel Events, the overlapping-run rule treats all manual runs as related."
      )
    ).toBeTruthy();
  });

  it("keeps what each choice does and the manual-run details in help", () => {
    const view = renderPanel();

    // The form holds the controls alone.
    expect(view.queryByText(/End related active runs/)).toBeNull();
    expect(view.queryByText(/the editor and API/)).toBeNull();
    expect(view.queryByText(/Correlation Path values/)).toBeNull();

    fireEvent.click(
      view.getByRole("button", {
        name: "About If a run is already in progress",
      })
    );
    expect(
      view.getByText(/End related active runs, then start the new run/)
    ).toBeTruthy();
    expect(
      view.getByText(
        "Start and Cancel Events use their Correlation Path values to identify related runs."
      )
    ).toBeTruthy();

    fireEvent.click(
      view.getByRole("button", { name: "About Can be run by hand" })
    );
    expect(
      view.getByText(/the editor and API can start runs by hand/)
    ).toBeTruthy();
    expect(
      view.getByText(/Entity tracking and Event Splits need a Start Event/)
    ).toBeTruthy();
  });
});
