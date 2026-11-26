import {
  fireEvent,
  render,
  type RenderResult,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { useState } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { FieldIssuesProvider } from "#src/components/workflow/config/field-issues";
import { LifecyclePanel } from "#src/components/workflow/config/lifecycle-panel";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { collectWorkflowIssues } from "@wfgraph/shared/graph/workflow-issues";
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

/**
 * The panel over config it owns, reporting each config it writes, over the
 * editor's issue list for the rules it starts with, inside the provider that
 * shows each refusal beneath its rule.
 */
function renderPanel(rules: LifecycleRules = MANUAL_ONLY) {
  const writes: LifecycleRules[] = [];
  const nodes: WorkflowNode[] = [
    {
      id: "lifecycle_1",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: {
        label: "Start",
        type: "lifecycle",
        config: { lifecycleRules: rules },
      },
    },
  ];
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });
  store.set(
    workflowIssuesAtom,
    collectWorkflowIssues({ nodes, edges: [], catalog, integrations: [] })
  );
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
      <JotaiProvider store={store}>
        <FieldIssuesProvider nodeId="lifecycle_1">
          <ControlledPanel />
        </FieldIssuesProvider>
      </JotaiProvider>
      <Toaster />
    </ExtensionCatalogProvider>
  );
  return { view, writes, latest: () => writes.at(-1) };
}

/**
 * Presses Add schedule, first adding the rule from "Add a rule" when the start
 * has no schedule yet, the way a builder reaches it.
 */
function addSchedule(view: RenderResult) {
  if (view.queryByRole("button", { name: "Add schedule" }) === null) {
    const trigger = view.getByRole("button", { name: "Add a rule" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyUp(trigger, { key: "ArrowDown" });
    fireEvent.click(view.getByRole("menuitem", { name: "On a schedule…" }));
  }
  fireEvent.click(view.getByRole("button", { name: "Add schedule" }));
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

/** What the schedule rule says about rows the stored rules cannot hold. */
function refusal(view: RenderResult): string | null {
  return (
    view.container.querySelector('[data-slot="unsaved-schedules"]')
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
  // Sonner keeps its toasts in module state, which the next test's Toaster
  // would show again.
  toast.dismiss();
});

describe("LifecyclePanel Schedule", () => {
  it("adds a daily 9:00 AM schedule in the browser's time zone", async () => {
    const { view, latest } = renderPanel();

    addSchedule(view);

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

    addSchedule(view);
    await waitFor(() => expect(latest()?.schedules).toHaveLength(1));
    addSchedule(view);

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

  it("removes a saved schedule while another row is invalid", async () => {
    const { view, latest } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [
        { cron: "0 9 * * *", timeZone: "UTC" },
        { cron: "0 18 * * *", timeZone: "UTC" },
      ],
    });

    choose(schedule(view, 2), "Repeats", "Custom");
    fireEvent.change(
      within(schedule(view, 2)).getByLabelText("Cron expression"),
      { target: { value: "0 18 * *" } }
    );
    expect(refusal(view)).toContain(
      "Schedule 2 isn't saved. A schedule needs a cron expression of five fields"
    );

    fireEvent.click(view.getByRole("button", { name: "Remove schedule 1" }));

    // The invalid row keeps the schedule it last saved.
    await waitFor(() => {
      expect(latest()?.schedules).toEqual([
        { cron: "0 18 * * *", timeZone: "UTC" },
      ]);
    });
    expect(await view.findByText("Schedule removed")).toBeTruthy();
    expect(refusal(view)).toContain(
      "Schedule 1 isn't saved. A schedule needs a cron expression of five fields"
    );
  });

  it("removes an unsaved row with no write and no toast", async () => {
    const { view, writes } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [{ cron: "0 9 * * *", timeZone: browserTimeZone() }],
    });

    addSchedule(view);
    expect(refusal(view)).toContain("Schedule 2 isn't saved.");

    fireEvent.click(view.getByRole("button", { name: "Remove schedule 1" }));

    // Schedule 2 duplicated schedule 1, so it now saves in its place and the
    // stored rules are what they were.
    expect(writes).toHaveLength(0);
    expect(refusal(view)).toBeNull();
    // Give a toast the time it takes to appear before saying none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.queryByText("Schedule removed")).toBeNull();
  });

  it("saves a valid row while another row stays invalid", async () => {
    // A zone no test machine runs in, so the added row is no duplicate.
    const { view, latest } = renderPanel({
      ...MANUAL_ONLY,
      schedules: [{ cron: "0 9 * * *", timeZone: "Pacific/Chatham" }],
    });

    choose(schedule(view, 1), "Repeats", "Custom");
    fireEvent.change(
      within(schedule(view, 1)).getByLabelText("Cron expression"),
      { target: { value: "0 9 * *" } }
    );
    addSchedule(view);

    await waitFor(() => {
      expect(latest()?.schedules).toEqual([
        { cron: "0 9 * * *", timeZone: "Pacific/Chatham" },
        { cron: "0 9 * * *", timeZone: browserTimeZone() },
      ]);
    });
    expect(refusal(view)).toContain("Schedule 1 isn't saved.");
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

  it("shows the refusal Publish gives a schedule on a tracked workflow", () => {
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

    expect(view.container.textContent).toContain(
      "A scheduled run carries no Entity, so a workflow that tracks an Entity cannot have a schedule."
    );
  });
});
