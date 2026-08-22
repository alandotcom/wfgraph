import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  CONCURRENCY_OPTIONS,
  LifecyclePanel,
} from "#src/components/workflow/config/lifecycle-panel";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const testCatalog: ExtensionCatalog = {
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

describe("LifecyclePanel view mode", () => {
  it("reads the configuration back as text", () => {
    const view = renderPanel();

    expect(view.getByText("Appointment created")).toBeTruthy();
    expect(view.getByText("appointment.id")).toBeTruthy();
    expect(view.getByText("Nightly sweep")).toBeTruthy();
    expect(view.getByText("sweep.id")).toBeTruthy();
    expect(view.getByText("Newest wins")).toBeTruthy();
    expect(view.getByText("Allowed")).toBeTruthy();
    expect(view.queryByLabelText("Start Events")).toBeNull();
    expect(view.queryAllByRole("radio")).toEqual([]);
  });

  it("switches the whole section between its two modes", () => {
    const view = renderPanel();

    fireEvent.click(view.getByRole("button", { name: "Edit Lifecycle Rules" }));
    expect(view.getByLabelText("Start Events")).toBeTruthy();
    expect(view.getByLabelText("Cancel Events")).toBeTruthy();
    expect(view.queryAllByRole("radio")).toHaveLength(
      CONCURRENCY_OPTIONS.length
    );

    fireEvent.click(
      view.getByRole("button", { name: "Done editing Lifecycle Rules" })
    );
    expect(view.queryByLabelText("Start Events")).toBeNull();
    expect(view.queryAllByRole("radio")).toEqual([]);
    expect(view.getByText("Appointment created")).toBeTruthy();
  });

  it("offers one Edit button for the whole configuration", () => {
    const view = renderPanel();

    expect(view.getAllByRole("button", { name: /^Edit / })).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "Edit Lifecycle Rules" }));
    expect(
      view.getAllByRole("button", { name: /^Done editing / })
    ).toHaveLength(1);
  });

  it("gives a disabled panel no way into edit mode", () => {
    const view = renderPanel(
      <LifecyclePanel config={CONFIGURED} disabled onUpdateConfig={vi.fn()} />
    );

    expect(view.queryAllByRole("button", { name: /^Edit / })).toEqual([]);
    expect(view.getByText("Newest wins")).toBeTruthy();
  });

  it("opens a section's help on a click", () => {
    const view = renderPanel();

    expect(
      view.queryByText(/A run starts when one of these Events/)
    ).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "About Start Events" }));
    expect(
      view.getByText(/A run starts when one of these Events/)
    ).toBeTruthy();
  });

  it("puts the concurrency setting in force at the top of its help", () => {
    const view = renderPanel();

    fireEvent.click(view.getByRole("button", { name: "About Concurrency" }));
    const described = view
      .getAllByText(
        /supersedes the ones already going|Every Event starts its own run/
      )
      .map((node) => node.textContent ?? "");
    expect(described.at(0)).toContain("supersedes the ones already going");
  });
});
