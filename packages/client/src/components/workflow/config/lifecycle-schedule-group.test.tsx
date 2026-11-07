import {
  fireEvent,
  render,
  type RenderResult,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { LifecyclePanel } from "#src/components/workflow/config/lifecycle-panel";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { browserTimeZone } from "./lifecycle-schedule";

const catalog: ExtensionCatalog = {
  entities: [
    {
      type: "patient",
      label: "Patient",
      stateFields: [{ path: "status", type: "string" }],
      stateSchemaDigest: "patient-state-v1",
    },
  ],
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      payloadFields: [{ path: "patient.id", type: "string" }],
      entityBindings: [{ name: "patient", entityType: "patient" }],
    },
  ],
  actions: [],
  integrations: [],
};

const MANUAL_ONLY: LifecycleRules = {
  startEvents: [],
  cancelEvents: [],
  concurrency: "unlimited",
  allowManualStart: true,
};

/** The panel over config it owns, reporting each config it writes. */
function renderPanel(rules: LifecycleRules = MANUAL_ONLY) {
  const writes: LifecycleRules[] = [];
  function ControlledPanel() {
    const [config, setConfig] = useState<Record<string, unknown>>({
      lifecycleRules: rules,
    });
    return (
      <LifecyclePanel
        config={config}
        disabled={false}
        onUpdateConfig={(patch) =>
          setConfig((previous) => {
            const next = { ...previous, ...patch };
            writes.push(next.lifecycleRules as LifecycleRules);
            return next;
          })
        }
      />
    );
  }
  const view = render(
    <ExtensionCatalogProvider value={catalog}>
      <ControlledPanel />
    </ExtensionCatalogProvider>
  );
  return { view, writes, latest: () => writes.at(-1) };
}

function schedule(view: RenderResult, number: number): HTMLElement {
  return view.getByRole("group", { name: `Schedule ${number}` });
}

function choose(scope: HTMLElement, name: string, option: string) {
  fireEvent.click(within(scope).getByRole("combobox", { name }));
  const choice = within(document.body).getByRole("option", { name: option });
  fireEvent.pointerDown(choice);
  fireEvent.click(choice);
}

function refusal(view: RenderResult): string | null {
  return (
    view.queryByText("Lifecycle settings need attention")?.parentElement
      ?.textContent ?? null
  );
}

beforeEach(() => {
  // Friday Nov 6, 2026, 7:00 AM in New York. Only Date is faked, so Base UI's
  // timers still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LifecyclePanel Schedule", () => {
  it("adds a daily 9:00 AM schedule in the browser's time zone", async () => {
    const { view, latest } = renderPanel();

    fireEvent.click(view.getByRole("button", { name: "Add schedule" }));

    await waitFor(() => {
      expect(latest()?.schedules).toEqual([
        { cron: "0 9 * * *", timeZone: browserTimeZone() },
      ]);
    });
    expect(
      within(schedule(view, 1)).getByText(
        `Every day at 9:00 AM (${browserTimeZone()})`
      )
    ).toBeTruthy();
  });

  it("reads back a weekday schedule with its next three runs", () => {
    const { view } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [{ cron: "0 9 * * 1-5", timeZone: "America/New_York" }],
    });

    const card = schedule(view, 1);
    expect(card.textContent).toContain(
      "Every weekday at 9:00 AM (America/New_York)"
    );
    expect(card.textContent).toContain(
      "Next: Fri Nov 6, 9:00 AM; Mon Nov 9, 9:00 AM; Tue Nov 10, 9:00 AM."
    );
    expect(
      within(card).getByRole("combobox", { name: "Repeats" }).textContent
    ).toContain("Every weekday at");
    expect(
      (within(card).getByLabelText("Time") as HTMLInputElement).value
    ).toBe("09:00");
  });

  it("writes a preset's time and weekday into the expression", async () => {
    const { view, latest } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [{ cron: "0 9 * * *", timeZone: "UTC" }],
    });

    choose(schedule(view, 1), "Repeats", "Every week on");
    await waitFor(() => {
      expect(latest()?.schedules?.[0]?.cron).toBe("0 9 * * 1");
    });

    choose(schedule(view, 1), "Day", "Friday");
    fireEvent.change(within(schedule(view, 1)).getByLabelText("Time"), {
      target: { value: "17:30" },
    });

    await waitFor(() => {
      expect(latest()?.schedules).toEqual([
        { cron: "30 17 * * 5", timeZone: "UTC" },
      ]);
    });
    expect(schedule(view, 1).textContent).toContain(
      "Every Friday at 5:30 PM (UTC)"
    );
  });

  it("keeps an invalid expression unsaved and says why", async () => {
    const { view, writes, latest } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [{ cron: "0 9 * * *", timeZone: "UTC" }],
    });

    choose(schedule(view, 1), "Repeats", "Custom");
    const expression = within(schedule(view, 1)).getByLabelText(
      "Cron expression"
    );
    expect((expression as HTMLInputElement).value).toBe("0 9 * * *");

    fireEvent.change(expression, { target: { value: "0 9 * *" } });

    expect(refusal(view)).toContain(
      "A schedule needs a cron expression of five fields"
    );
    expect(expression.getAttribute("aria-invalid")).toBe("true");
    expect(writes).toHaveLength(0);

    fireEvent.change(expression, { target: { value: "*/15 * * * *" } });

    await waitFor(() => {
      expect(latest()?.schedules).toEqual([
        { cron: "*/15 * * * *", timeZone: "UTC" },
      ]);
    });
    expect(refusal(view)).toBeNull();
    // A Custom row stays Custom after a save, even where a preset could show it.
    expect(
      within(schedule(view, 1)).getByRole("combobox", { name: "Repeats" })
        .textContent
    ).toContain("Custom");
  });

  it("refuses a duplicate schedule until one is removed", async () => {
    const { view, latest } = renderPanel();

    fireEvent.click(view.getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(latest()?.schedules).toHaveLength(1));
    fireEvent.click(view.getByRole("button", { name: "Add schedule" }));

    expect(refusal(view)).toContain(
      "Two schedules have the same cron expression and time zone. Remove one of them."
    );
    expect(latest()?.schedules).toHaveLength(1);

    fireEvent.change(within(schedule(view, 2)).getByLabelText("Time"), {
      target: { value: "18:00" },
    });

    await waitFor(() => {
      expect(latest()?.schedules?.map((entry) => entry.cron)).toEqual([
        "0 9 * * *",
        "0 18 * * *",
      ]);
    });
    expect(refusal(view)).toBeNull();
  });

  it("removes a schedule and writes the rules without one", async () => {
    const { view, latest } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [{ cron: "0 9 * * *", timeZone: "UTC" }],
    });

    fireEvent.click(view.getByRole("button", { name: "Remove schedule 1" }));

    await waitFor(() => {
      expect(latest()?.schedules).toBeUndefined();
    });
    expect(view.queryByRole("group", { name: "Schedule 1" })).toBeNull();
  });

  it("writes the time zone the builder picks", async () => {
    const { view, latest } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [{ cron: "0 9 * * *", timeZone: "UTC" }],
    });

    const zone = within(schedule(view, 1)).getByLabelText("Time zone");
    fireEvent.keyDown(zone, { key: "ArrowDown" });
    fireEvent.change(zone, { target: { value: "new york" } });
    const listbox = document.getElementById(
      zone.getAttribute("aria-controls") ?? ""
    );
    if (!listbox) {
      throw new Error("The time zone list never opened");
    }
    fireEvent.click(
      within(listbox).getByRole("option", { name: "America/New_York" })
    );

    await waitFor(() => {
      expect(latest()?.schedules).toEqual([
        { cron: "0 9 * * *", timeZone: "America/New_York" },
      ]);
    });
  });

  it("shows the save refusal for a schedule on a tracked workflow", () => {
    const { view } = renderPanel({
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
      trackedEntity: {
        type: "patient",
        bindings: { "app/appointment.created": "patient" },
      },
      schedules: [{ cron: "0 9 * * *", timeZone: "UTC" }],
    });

    expect(refusal(view)).toContain(
      "A scheduled run carries no Entity, so a workflow that tracks an Entity cannot have a schedule."
    );
  });

  it("summarizes each schedule with its next run", () => {
    const { view } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [
        { cron: "0 9 * * 1-5", timeZone: "America/New_York" },
        { cron: "*/15 * * * *", timeZone: "UTC" },
      ],
    });

    const summary = view
      .getAllByRole("heading", { name: "Schedule" })
      .map((heading) => heading.closest("section")?.textContent ?? "")
      .find((text) => text.includes("Next run"));
    expect(summary).toContain(
      "Every weekday at 9:00 AM (America/New_York)Next run: Fri Nov 6, 9:00 AM"
    );
    expect(summary).toContain(
      "Every 15 minutes (UTC)Next run: Fri Nov 6, 12:15 PM"
    );
  });
});
