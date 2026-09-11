import {
  fireEvent,
  render,
  type RenderResult,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type ReactElement, type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  CONCURRENCY_OPTIONS,
  LifecyclePanel,
} from "#src/components/workflow/config/lifecycle-panel";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { checkEntityEligibility } from "@wfgraph/shared/lifecycle/entity-eligibility";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

const testCatalog: ExtensionCatalog = {
  entities: [
    {
      type: "appointment",
      label: "Appointment",
      stateFields: [
        {
          path: "status",
          type: "string",
          enumValues: ["scheduled", "completed", "canceled"],
        },
        { path: "remindersEnabled", type: "boolean" },
        { path: "timezone", type: "string" },
      ],
      stateSchemaDigest: "appointment-state-v1",
    },
  ],
  events: [
    {
      name: "app/appointment.created",
      label: "Appointment created",
      correlationPath: "appointment.id",
      payloadFields: [
        { path: "appointment", type: "object" },
        { path: "appointment.id", type: "string" },
        { path: "appointment.duration", type: "number" },
        { path: "appointment.attendees", type: "array" },
        { path: "patient.id", type: "string" },
        { path: "tenantId", type: "string" },
      ],
      entityBindings: [
        { name: "appointment", entityType: "appointment" },
        { name: "legacy-appointment", entityType: "appointment" },
      ],
    },
    {
      name: "ops/nightly.swept",
      label: "Nightly sweep",
      payloadFields: [
        { path: "sweep.id", type: "string" },
        { path: "sweep.count", type: "number" },
        // The one path both Events declare, which is what a filter standing for
        // the two of them has to be written in.
        { path: "tenantId", type: "string" },
      ],
      entityBindings: [{ name: "appointment", entityType: "appointment" }],
    },
    {
      name: "ops/no.overlap",
      label: "No overlap",
      payloadFields: [{ path: "other.id", type: "string" }],
    },
  ],
  actions: [],
  integrations: [],
};

function renderWithCatalog(ui: ReactElement) {
  return render(
    <ExtensionCatalogProvider value={testCatalog}>
      {ui}
    </ExtensionCatalogProvider>
  );
}

const NO_CONFIG: Record<string, unknown> = {};

function ControlledPanel({
  initialConfig = NO_CONFIG,
  onConfigChange,
}: {
  initialConfig?: Record<string, unknown>;
  onConfigChange?: (config: Record<string, unknown>) => void;
}) {
  const [config, setConfig] = useState(initialConfig);

  return (
    <LifecyclePanel
      config={config}
      disabled={false}
      onUpdateConfig={(patch) =>
        setConfig((prev) => {
          const next = { ...prev, ...patch };
          onConfigChange?.(next);
          return next;
        })
      }
    />
  );
}

/** The graph the panel reads its Wait Events from, seeded the way the loader does. */
function withGraph(nodes: WorkflowNode[], children: ReactNode) {
  const store = createStore();
  store.set(loadWorkflowGraphAtom, { nodes, edges: [] });

  return (
    <ExtensionCatalogProvider value={testCatalog}>
      <JotaiProvider store={store}>{children}</JotaiProvider>
    </ExtensionCatalogProvider>
  );
}

function waitNode(events: string[]): WorkflowNode {
  return {
    id: "wait-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: events.map((event) => ({ event })),
      },
    },
  };
}

function rulesOf(config: Record<string, unknown>): LifecycleRules {
  return config.lifecycleRules as LifecycleRules;
}

/**
 * Search one of the two pickers and take the first Event it offers.
 *
 * The popup opens on an arrow key rather than a click: a pointer press reaches
 * the list through events happy-dom does not deliver whole, and the keyboard
 * path is the one a builder filtering a long list takes anyway. The option is
 * looked up through the input's own `aria-controls` rather than the page's
 * whole role="option" set, because two comboboxes can be open on this screen at
 * once.
 */
function chooseEvent(view: RenderResult, label: string, query: string) {
  const input = view.getByLabelText(label);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.change(input, { target: { value: query } });

  const listboxId = input.getAttribute("aria-controls");
  const listbox = listboxId && document.getElementById(listboxId);
  if (!listbox) {
    throw new Error(`The ${label} picker's popup never opened`);
  }

  const option = within(listbox).queryAllByRole("option").at(0);
  if (!option) {
    throw new Error(`No Event matched "${query}" in the ${label} picker`);
  }
  fireEvent.click(option);
}

/**
 * One Event's Correlation Path picker, found by the Event's name.
 *
 * The name is the picker's accessible label, carried by a visually hidden
 * `<Label>`, because the Event's own heading is the caller's to render.
 */
function pathPicker(view: RenderResult, eventName: string): HTMLElement {
  return view.getByLabelText(`Correlation Path for ${eventName}`);
}

/** What a closed picker shows, which is the label of the path in force. */
function pathInForce(view: RenderResult, eventName: string): string {
  return pathPicker(view, eventName).textContent ?? "";
}

/**
 * Open one Event's Correlation Path picker and take the option named.
 *
 * Base UI mounts the popup only while it is open, so the options are looked up
 * after the trigger rather than up front. The press starts with a pointer event:
 * an option ignores a click that began nowhere on it, which is how it survives a
 * popup opening under a stationary cursor.
 */
function choosePath(view: RenderResult, eventName: string, option: string) {
  fireEvent.click(pathPicker(view, eventName));

  const choice = view.getByRole("option", { name: option });
  fireEvent.pointerDown(choice);
  fireEvent.click(choice);
}

/** Pick an overlapping-run setting by the words its option carries. */
function chooseConcurrency(view: RenderResult, label: string) {
  fireEvent.click(view.getByRole("combobox", { name: "Overlapping runs" }));

  const choice = view.getByRole("option", { name: label });
  fireEvent.pointerDown(choice);
  fireEvent.click(choice);
}

function chooseSelect(view: RenderResult, name: string, option: string) {
  fireEvent.click(view.getByRole("combobox", { name }));
  const choice = view.getByRole("option", { name: option });
  fireEvent.pointerDown(choice);
  fireEvent.click(choice);
}

/** Every path the picker offers, in the order it lists them. */
function pathChoices(view: RenderResult, eventName: string): string[] {
  fireEvent.click(pathPicker(view, eventName));

  return view.getAllByRole("option").map((option) => option.textContent ?? "");
}

describe("LifecyclePanel", () => {
  // The moment rules exist they are held to the start-source rule, so the first
  // write has to carry a start source or it refuses the save that wrote it.
  it("carries manual starts into the rules it first writes", async () => {
    let latest: Record<string, unknown> = {};
    const view = renderWithCatalog(
      <ControlledPanel
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Events", "Appointment created");

    await waitFor(() => {
      expect(rulesOf(latest)).toEqual({
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      });
    });
  });

  // Opening a panel is not an edit: writing on mount would autosave rules nobody
  // asked for, and erase the difference between "never configured" and
  // "configured this way".
  it("writes nothing until something is edited", () => {
    const onUpdateConfig = vi.fn();
    const view = renderWithCatalog(
      <LifecyclePanel
        config={{}}
        disabled={false}
        onUpdateConfig={onUpdateConfig}
      />
    );

    expect(onUpdateConfig).not.toHaveBeenCalled();

    chooseEvent(view, "Start Events", "Appointment created");

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
  });

  // The trigger button is the pointer path into a picker's full list, beside
  // the keyboard path `chooseEvent` drives everywhere else in this file.
  it("opens the Start Event picker from its trigger button", () => {
    const view = renderWithCatalog(
      <LifecyclePanel config={{}} disabled={false} onUpdateConfig={vi.fn()} />
    );

    fireEvent.click(
      view.getAllByRole("button", { name: "Show the Events" })[0]
    );

    expect(
      view.getByRole("option", { name: /Appointment created/ })
    ).toBeTruthy();
  });

  // The raw name is what a sender posts and what a builder coming from that side
  // knows the Event by, so it is searchable beside the label.
  it("finds an Event by the name a sender posts", async () => {
    let latest: Record<string, unknown> = {};
    const view = renderWithCatalog(
      <ControlledPanel
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Events", "ops/nightly");

    await waitFor(() => {
      expect(rulesOf(latest).startEvents).toEqual(["ops/nightly.swept"]);
    });
  });

  // Several Start Events is the point: an appointment being booked and being
  // moved both start a run of one workflow.
  it("adds a second Start Event beside the first", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Events", "Nightly sweep");

    await waitFor(() => {
      expect(rulesOf(latest).startEvents).toEqual([
        "app/appointment.created",
        "ops/nightly.swept",
      ]);
    });
  });

  it.each(CONCURRENCY_OPTIONS.map((option) => [option.label, option.value]))(
    "writes the %s setting the builder picked",
    async (label, value) => {
      let latest: Record<string, unknown> = {
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: [],
          concurrency: value === "unlimited" ? "newest-wins" : "unlimited",
        },
      };
      const view = renderWithCatalog(
        <ControlledPanel
          initialConfig={latest}
          onConfigChange={(config) => {
            latest = config;
          }}
        />
      );

      chooseConcurrency(view, label);

      await waitFor(() => {
        expect(rulesOf(latest).concurrency).toBe(value);
      });
    }
  );

  it("turns manual runs off and drops the Start Event", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.click(view.getByRole("checkbox", { name: "Allow manual runs" }));
    await waitFor(() => {
      expect(rulesOf(latest).allowManualStart).toBe(false);
    });

    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );
    await waitFor(() => {
      expect(rulesOf(latest).startEvents).toEqual([]);
    });
  });

  it("says a manual run's payload is described by nothing", async () => {
    // What the editor can offer downstream comes off the Start Event, so a
    // workflow with none leaves the picker empty. The panel says so rather than
    // leaving that silence to be read as a missing feature.
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    expect(view.queryByText(/provide no payload fields/)).toBeNull();

    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );

    // A consequence of the configuration rather than an explanation of a
    // control, so it stays in the column rather than moving into the help
    // popover the Concurrency heading offers.
    await waitFor(() => {
      expect(view.getByText(/provide no payload fields/)).toBeTruthy();
    });
  });
});

describe("LifecyclePanel Cancel Events", () => {
  it("writes a cancel Event pick to lifecycleRules.cancelEvents", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Cancel Events", "Appointment created");

    await waitFor(() => {
      expect(rulesOf(latest).cancelEvents).toEqual(["app/appointment.created"]);
    });
  });

  it("drops a chosen cancel Event when its row is removed", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: ["app/appointment.created", "ops/nightly.swept"],
        concurrency: "unlimited",
        allowManualStart: true,
        correlationPaths: { "ops/nightly.swept": "sweep.id" },
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );

    await waitFor(() => {
      expect(rulesOf(latest).cancelEvents).toEqual(["ops/nightly.swept"]);
    });
  });

  // The path is what an arriving payload is compared against, so every chosen
  // Event gets a picker of its own: an Event declaring the wrong field for this
  // workflow would otherwise be a rule the builder can read and cannot fix.
  it("gives each chosen Event a picker, defaulted to its declaration", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: [],
            cancelEvents: ["app/appointment.created", "ops/nightly.swept"],
            concurrency: "unlimited",
            allowManualStart: true,
          },
        }}
      />
    );

    expect(pathInForce(view, "app/appointment.created")).toBe("appointment.id");
    expect(pathInForce(view, "ops/nightly.swept")).toBe("Choose a path");
  });

  it("shows the builder's override in the picker", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: [],
            cancelEvents: ["ops/nightly.swept"],
            concurrency: "unlimited",
            allowManualStart: true,
            correlationPaths: { "ops/nightly.swept": "sweep.id" },
          },
        }}
      />
    );

    expect(pathInForce(view, "ops/nightly.swept")).toBe("sweep.id");
  });

  // The Event Author's declaration is a default the workflow may disagree with,
  // and a builder who cannot choose past it has to ask for a second Event.
  it("writes an override for an Event that declares its own path", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: [],
        cancelEvents: ["app/appointment.created"],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    choosePath(view, "app/appointment.created", "patient.id");

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toEqual({
        "app/appointment.created": "patient.id",
      });
    });
  });

  // ADR-0007 refuses one Event holding both roles rather than picking a
  // winner, and the panel runs that same check.
  it("shows the shared refusal when a pick gives one Event both roles", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    expect(view.queryByText("Lifecycle settings need attention")).toBeNull();

    chooseEvent(view, "Cancel Events", "Appointment created");

    await waitFor(() => {
      expect(
        view.getByText(
          'Event "app/appointment.created" cannot both start and cancel runs of this workflow. Give it one role, or start on one Event and cancel on another.'
        )
      ).toBeTruthy();
    });
  });
});

describe("LifecyclePanel Correlation Paths", () => {
  // The Event Author declared no path, so the builder chooses one from the
  // payload, keyed by the Event it belongs to.
  it("commits the payload path the builder chose", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["ops/nightly.swept"],
        cancelEvents: [],
        concurrency: "newest-wins",
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    choosePath(view, "ops/nightly.swept", "sweep.id");

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toEqual({
        "ops/nightly.swept": "sweep.id",
      });
    });
  });

  // An Event declaring no path of its own is cleared back to the prompt, which
  // is what leaves the workflow saying it has no path to match on.
  it("clears one path and keeps the others", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["ops/nightly.swept"],
        cancelEvents: [],
        concurrency: "newest-wins",
        correlationPaths: {
          "ops/nightly.swept": "sweep.id",
          "vendor/thing.happened": "thing.id",
        },
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    choosePath(view, "ops/nightly.swept", "Choose a path");

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toEqual({
        "vendor/thing.happened": "thing.id",
      });
    });
  });

  // The other route back to no override, for an Event carrying a declaration:
  // choosing the path it already declares says the same thing an override for
  // that path would, so the workflow stores nothing and the declaration stands.
  it("stores no override when the declared path is the one chosen", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "newest-wins",
        correlationPaths: {
          "app/appointment.created": "patient.id",
          "vendor/thing.happened": "thing.id",
        },
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    choosePath(view, "app/appointment.created", "appointment.id");

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toEqual({
        "vendor/thing.happened": "thing.id",
      });
    });
  });

  // An empty record would be a member holding nothing, so the last path clearing
  // takes the member with it.
  it("collapses to no paths at all when the last one clears", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["ops/nightly.swept"],
        cancelEvents: [],
        concurrency: "newest-wins",
        correlationPaths: { "ops/nightly.swept": "sweep.id" },
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    choosePath(view, "ops/nightly.swept", "Choose a path");

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toBeUndefined();
    });
  });

  // A Correlation Path names the value identifying one entity, so a path holding
  // a whole object or a list of them is no candidate and never reaches the list.
  // The payload declares one of each beside the fields that can be matched on.
  it("offers only the payload paths that can identify an entity", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
          },
        }}
      />
    );

    expect(pathChoices(view, "app/appointment.created")).toEqual([
      "appointment.id",
      "appointment.duration",
      "patient.id",
      "tenantId",
    ]);
  });

  // A workflow saved against an older payload shape keeps matching on the path
  // it was saved with, so the picker lists that path rather than dropping it and
  // appearing to match on the declaration.
  it("keeps a stored path this Event no longer declares", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
            correlationPaths: { "app/appointment.created": "legacy.reference" },
          },
        }}
      />
    );

    expect(pathInForce(view, "app/appointment.created")).toBe(
      "legacy.reference"
    );
    expect(pathChoices(view, "app/appointment.created")).toContain(
      "legacy.reference"
    );
  });

  // F1's repro, entirely through the panel: an override written while
  // Concurrency compares must not survive a switch back to Unlimited with no
  // Cancel Event to keep it alive. Before the prune, the field's disappearance
  // was cosmetic and the override kept governing every run in silence.
  it("prunes a stale start override on a switch back to Unlimited with no cancels", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    // Concurrency now compares, so the field appears; the builder overrides it.
    chooseConcurrency(view, "Start the newest run");
    await waitFor(() => {
      expect(rulesOf(latest).concurrency).toBe("newest-wins");
    });

    choosePath(view, "app/appointment.created", "patient.id");
    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toEqual({
        "app/appointment.created": "patient.id",
      });
    });

    // Back to Unlimited, with no Cancel Event to keep the override alive: the
    // field leaves the screen, and the pruned outcome is what is pinned here --
    // the stored override goes with it rather than surviving unseen.
    chooseConcurrency(view, "Start every run");
    await waitFor(() => {
      expect(rulesOf(latest).concurrency).toBe("unlimited");
    });

    expect(rulesOf(latest).correlationPaths).toBeUndefined();
    expect(view.queryByLabelText("app/appointment.created")).toBeNull();
  });

  // An Event carrying its own path still gets a picker, standing at that
  // declaration and writing nothing: a builder who only opened the panel has
  // stated no override.
  it("offers a picker for a Start Event that declares its own path", () => {
    const onConfigChange = vi.fn();
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "newest-wins",
          },
        }}
        onConfigChange={onConfigChange}
      />
    );

    expect(pathInForce(view, "app/appointment.created")).toBe("appointment.id");
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(view.queryByText("Lifecycle settings need attention")).toBeNull();
  });

  // Unlimited compares no entities, so there is no value to compare and no input.
  it("asks for no path when nothing compares entities", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: ["ops/nightly.swept"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        }}
      />
    );

    expect(view.queryByLabelText("ops/nightly.swept")).toBeNull();
  });

  // A cancel role matches by entity too, so an Event picked to cancel and
  // declaring no path owes one exactly as a start pick would. The row's own
  // heading names the Event; the field carries no second, role-labelled one.
  it("asks for a path when a cancel pick owes one", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: [],
            cancelEvents: ["ops/nightly.swept"],
            concurrency: "unlimited",
            allowManualStart: true,
          },
        }}
      />
    );

    expect(
      view.getByLabelText("Correlation Path for ops/nightly.swept")
    ).toBeTruthy();
    expect(view.getByRole("heading", { name: "Nightly sweep" })).toBeTruthy();
  });

  // A Wait Subscription carries its own match expression, so nothing a Wait node
  // parks on is asked about here. The rules answer for start and cancel roles.
  it("asks nothing on account of a Wait node", () => {
    const view = renderWithCatalog(
      withGraph(
        [waitNode(["ops/nightly.swept"])],
        <ControlledPanel
          initialConfig={{
            lifecycleRules: {
              startEvents: ["app/appointment.created"],
              cancelEvents: [],
              concurrency: "unlimited",
              allowManualStart: true,
            },
          }}
        />
      )
    );

    expect(view.queryByLabelText("ops/nightly.swept")).toBeNull();
    expect(view.queryByText("Lifecycle settings need attention")).toBeNull();
  });
});

describe("LifecyclePanel Entity eligibility", () => {
  const configuredStart: Record<string, unknown> = {
    lifecycleRules: {
      startEvents: ["app/appointment.created"],
      cancelEvents: [],
      concurrency: "unlimited",
      allowManualStart: false,
    } satisfies LifecycleRules,
  };

  it("selects a tracked Entity and its Event binding", async () => {
    let latest = configuredStart;
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={configuredStart}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseSelect(view, "Track runs by", "Appointment");

    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity).toEqual({
        type: "appointment",
        bindings: {
          "app/appointment.created": "appointment",
        },
      });
    });
    expect(rulesOf(latest).entityEligibility).toBeUndefined();
    expect(
      view.getByRole("combobox", {
        name: "Appointment in Appointment created",
      })
    ).toBeTruthy();
    expect(
      view
        .getByRole("button", { name: "Configure condition" })
        .hasAttribute("disabled")
    ).toBe(false);
  });

  // A Correlation Path and an Entity are two ways of establishing the same
  // identity, and the rules refuse holding both. Selecting an Entity while a
  // Correlation Path is still stored must drop that path, or the builder is
  // left with a refused save that none of the visible controls can fix.
  it("clears a stored Correlation Path when an Entity is selected", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        ...rulesOf(configuredStart),
        correlationPaths: { "app/appointment.created": "appointment.id" },
      } satisfies LifecycleRules,
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseSelect(view, "Track runs by", "Appointment");

    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity).toEqual({
        type: "appointment",
        bindings: { "app/appointment.created": "appointment" },
      });
    });
    expect(rulesOf(latest).correlationPaths).toBeUndefined();
    expect(
      checkEntityEligibility({ rules: rulesOf(latest), catalog: testCatalog })
        .valid
    ).toBe(true);
  });

  it("clears eligibility when the tracked Entity changes", async () => {
    const switchCatalog: ExtensionCatalog = {
      ...testCatalog,
      entities: [
        ...testCatalog.entities,
        {
          type: "patient",
          label: "Patient",
          stateFields: [{ path: "status", type: "string" }],
          stateSchemaDigest: "patient-state-v1",
        },
      ],
      events: testCatalog.events.map((event) =>
        event.name === "app/appointment.created"
          ? {
              ...event,
              entityBindings: [
                ...(event.entityBindings ?? []),
                { name: "patient", entityType: "patient" },
              ],
            }
          : event
      ),
    };
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        ...rulesOf(configuredStart),
        trackedEntity: {
          type: "appointment",
          bindings: { "app/appointment.created": "appointment" },
        },
        entityEligibility: {
          condition: "condition for appointment",
          checkpoints: ["before-execution"],
        },
      } satisfies LifecycleRules,
    };
    const view = render(
      <ExtensionCatalogProvider value={switchCatalog}>
        <ControlledPanel
          initialConfig={latest}
          onConfigChange={(config) => {
            latest = config;
          }}
        />
      </ExtensionCatalogProvider>
    );

    chooseSelect(view, "Track runs by", "Patient");

    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity).toEqual({
        type: "patient",
        bindings: { "app/appointment.created": "patient" },
      });
    });
    expect(rulesOf(latest).entityEligibility).toBeUndefined();
  });

  it("identifies a tracked Entity that the app no longer declares", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            ...rulesOf(configuredStart),
            trackedEntity: {
              type: "removed-entity",
              bindings: { "app/appointment.created": "appointment" },
            },
          } satisfies LifecycleRules,
        }}
      />
    );

    expect(
      view.getByText(
        "removed-entity is no longer available. Choose an Entity this app declares, or ask the host to restore it."
      )
    ).toBeTruthy();
    expect(
      view
        .getByRole("combobox", { name: "Track runs by" })
        .getAttribute("aria-invalid")
    ).toBe("true");
  });

  it("binds every Start and Cancel Event before enabling the guard", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        ...rulesOf(configuredStart),
        cancelEvents: ["ops/nightly.swept"],
      } satisfies LifecycleRules,
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseSelect(view, "Track runs by", "Appointment");

    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity?.bindings).toEqual({
        "app/appointment.created": "appointment",
        "ops/nightly.swept": "appointment",
      });
    });
    expect(view.getByText("Uses appointment automatically")).toBeTruthy();
  });

  it("repairs bindings when Lifecycle Events are added or removed", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        ...rulesOf(configuredStart),
        trackedEntity: {
          type: "appointment",
          bindings: { "app/appointment.created": "appointment" },
        },
        entityEligibility: {
          condition: "",
          checkpoints: ["before-execution"],
        },
      } satisfies LifecycleRules,
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Cancel Events", "Nightly");
    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity?.bindings).toEqual({
        "app/appointment.created": "appointment",
        "ops/nightly.swept": "appointment",
      });
    });

    fireEvent.click(
      view.getByRole("button", { name: "Remove ops/nightly.swept" })
    );
    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity?.bindings).toEqual({
        "app/appointment.created": "appointment",
      });
    });
  });

  it("offers only current Entity State to the condition editor", async () => {
    const view = renderWithCatalog(
      <ControlledPanel initialConfig={configuredStart} />
    );

    chooseSelect(view, "Track runs by", "Appointment");
    fireEvent.click(
      await view.findByRole("button", { name: "Configure condition" })
    );
    fireEvent.keyDown(view.getByLabelText("Select field"), {
      key: "ArrowDown",
    });

    const choices = view
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(choices).toEqual(
      expect.arrayContaining(["remindersEnabled", "status"])
    );
    expect(choices).not.toEqual(
      expect.arrayContaining(["patient.id", "tenantId", "sweep.id"])
    );
  });

  /**
   * Track the Appointment, seed an eligibility rule on `fieldPath`, and list the
   * operators its picker offers.
   */
  async function eligibilityOperators(fieldPath: string): Promise<string[]> {
    const view = renderWithCatalog(
      <ControlledPanel initialConfig={configuredStart} />
    );

    chooseSelect(view, "Track runs by", "Appointment");
    fireEvent.click(
      await view.findByRole("button", { name: "Configure condition" })
    );
    const fieldInput = view.getByLabelText("Select field");
    fireEvent.keyDown(fieldInput, { key: "ArrowDown" });
    fireEvent.change(fieldInput, { target: { value: fieldPath } });
    fireEvent.click(view.getByRole("option", { name: fieldPath }));

    fireEvent.click(
      view.getByRole("combobox", { name: `${fieldPath} operator` })
    );
    return view
      .getAllByRole("option")
      .map((option) => option.textContent ?? "");
  }

  // Entity Eligibility refuses a set comparison on a string field with no enum
  // values, so its builder must not offer one there.
  it("offers no set operator on a string field without enum values", async () => {
    const operators = await eligibilityOperators("timezone");

    expect(operators).toContain("equals");
    expect(operators).not.toContain("is one of");
    expect(operators).not.toContain("is not one of");
  });

  it("offers set operators on a string field with enum values", async () => {
    const operators = await eligibilityOperators("status");

    expect(operators).toEqual(
      expect.arrayContaining(["is one of", "is not one of"])
    );
  });

  it("repairs a stale binding on every Entity Eligibility write", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        ...rulesOf(configuredStart),
        trackedEntity: {
          type: "appointment",
          bindings: { "app/appointment.created": "removed-binding" },
        },
        entityEligibility: {
          condition: "",
          checkpoints: ["before-execution", "before-node"],
        },
      } satisfies LifecycleRules,
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.click(view.getByRole("checkbox", { name: "Before each step" }));

    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity?.bindings).toEqual({
        "app/appointment.created": "appointment",
      });
    });
  });

  it("disables every Entity Eligibility control in read-only mode", () => {
    const view = renderWithCatalog(
      <LifecyclePanel
        config={{
          lifecycleRules: {
            ...rulesOf(configuredStart),
            trackedEntity: {
              type: "appointment",
              bindings: { "app/appointment.created": "appointment" },
            },
            entityEligibility: {
              condition: "",
              checkpoints: ["before-execution", "before-node"],
            },
          } satisfies LifecycleRules,
        }}
        disabled
        onUpdateConfig={() => undefined}
      />
    );

    for (const control of [
      view.getByRole("combobox", { name: "Track runs by" }),
      view.getByRole("button", { name: "Configure condition" }),
      view.getByRole("button", {
        name: "Remove tracking and eligibility",
      }),
    ]) {
      expect(control.hasAttribute("disabled")).toBe(true);
    }
    expect(
      view
        .getByRole("checkbox", { name: "Before starting a run" })
        .getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      view
        .getByRole("checkbox", { name: "Before each step" })
        .getAttribute("aria-disabled")
    ).toBe("true");
  });

  it("supports each checkpoint combination and removing the guard", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        ...rulesOf(configuredStart),
        trackedEntity: {
          type: "appointment",
          bindings: { "app/appointment.created": "appointment" },
        },
        entityEligibility: {
          condition: "condition",
          checkpoints: ["before-execution", "before-node"],
        },
      } satisfies LifecycleRules,
    };
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.click(view.getByRole("checkbox", { name: "Before each step" }));
    await waitFor(() => {
      expect(rulesOf(latest).entityEligibility?.checkpoints).toEqual([
        "before-execution",
      ]);
    });

    fireEvent.click(view.getByRole("checkbox", { name: "Before each step" }));
    fireEvent.click(
      view.getByRole("checkbox", { name: "Before starting a run" })
    );
    await waitFor(() => {
      expect(rulesOf(latest).entityEligibility?.checkpoints).toEqual([
        "before-node",
      ]);
    });

    fireEvent.click(
      view.getByRole("checkbox", { name: "Before starting a run" })
    );
    await waitFor(() => {
      expect(rulesOf(latest).entityEligibility?.checkpoints).toEqual([
        "before-node",
        "before-execution",
      ]);
    });

    fireEvent.click(
      view.getByRole("button", { name: "Remove tracking and eligibility" })
    );
    await waitFor(() => {
      expect(rulesOf(latest).trackedEntity).toBeUndefined();
      expect(rulesOf(latest).entityEligibility).toBeUndefined();
    });
  });
});

describe("LifecyclePanel refusals", () => {
  // The panel runs the same check the save is refused by, so the sentence is
  // there before a builder waits for a toast to tell them.
  it("shows the refusal a save would answer with", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: [],
            cancelEvents: [],
            concurrency: "unlimited",
            allowManualStart: false,
          },
        }}
      />
    );

    expect(view.getByText("Lifecycle settings need attention")).toBeTruthy();
    expect(
      view.getByText(
        "Nothing can start this workflow. Add a Start Event, or allow manual starts."
      )
    ).toBeTruthy();
  });

  it("names an Event the catalog does not declare as the refusal it is", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: ["app/appointment.moved"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        }}
      />
    );

    expect(
      view.getByText(/^No Event named "app\/appointment\.moved" is defined/)
    ).toBeTruthy();
  });
});

/**
 * Start Filters: the condition an arrival must satisfy before a run opens.
 *
 * The layout is what these cases are about. One control stands for every Start
 * Event while they agree, because that is what a builder writing "only video
 * appointments" means, and it splits into one control per Event the moment they
 * need to say different things.
 */
describe("LifecyclePanel start filters", () => {
  /** A finished one-rule filter over a path both fixture Events declare. */
  function filterOnTenant(path = "tenantId"): string {
    return JSON.stringify({
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group",
          logic: "and",
          conditions: [
            {
              id: "rule",
              field: path,
              fieldType: "string",
              operator: "equals",
              value: "t_1",
            },
          ],
        },
      ],
    });
  }

  function withStartEvents(startEvents: string[], startFilters?: unknown) {
    return {
      lifecycleRules: {
        startEvents,
        cancelEvents: [],
        concurrency: "unlimited",
        startFilters,
      },
    } satisfies Record<string, unknown>;
  }

  it("offers one filter for a single Start Event", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={withStartEvents(["app/appointment.created"])}
      />
    );

    expect(view.getAllByRole("button", { name: "Add a filter" })).toHaveLength(
      1
    );
    expect(
      view.queryByRole("button", { name: "Filter each Event separately" })
    ).toBeNull();
  });

  it("names a filter action for the Event it edits", () => {
    const model = filterOnTenant();
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={withStartEvents(["app/appointment.created"], {
          "app/appointment.created": model,
        })}
      />
    );

    const edit = view.getByRole("button", {
      name: "Edit filter for Appointment created",
    });
    fireEvent.click(edit);

    expect(
      view.getByRole("button", {
        name: "Done editing filter for Appointment created",
      })
    ).toBeTruthy();
  });

  it("writes one filter to every Start Event while they agree", async () => {
    let latest: Record<string, unknown> = withStartEvents([
      "app/appointment.created",
      "ops/nightly.swept",
    ]);
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    // Two Start Events agreeing on no filter is still agreement, so one control
    // stands for both.
    expect(view.getAllByRole("button", { name: "Add a filter" })).toHaveLength(
      1
    );
    fireEvent.click(view.getByRole("button", { name: "Add a filter" }));

    await waitFor(() => {
      const filters = rulesOf(latest).startFilters ?? {};
      expect(Object.keys(filters)).toEqual([
        "app/appointment.created",
        "ops/nightly.swept",
      ]);
      expect(filters["app/appointment.created"]).toBe(
        filters["ops/nightly.swept"]
      );
    });
  });

  it("splits into one filter per Start Event when asked", async () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={withStartEvents([
          "app/appointment.created",
          "ops/nightly.swept",
        ])}
      />
    );

    fireEvent.click(
      view.getByRole("button", {
        name: "Use a different filter for each event",
      })
    );

    await waitFor(() => {
      expect(
        view.getAllByRole("button", { name: "Add a filter" })
      ).toHaveLength(2);
    });
    expect(
      view.getByRole("button", { name: "Use one filter for all events" })
    ).toBeTruthy();
  });

  it("writes a split filter to the one Event whose row wrote it", async () => {
    let latest: Record<string, unknown> = withStartEvents([
      "app/appointment.created",
      "ops/nightly.swept",
    ]);
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.click(
      view.getByRole("button", {
        name: "Use a different filter for each event",
      })
    );
    fireEvent.click(
      view.getAllByRole("button", { name: "Add a filter" })[0] as HTMLElement
    );

    await waitFor(() => {
      expect(Object.keys(rulesOf(latest).startFilters ?? {})).toEqual([
        "app/appointment.created",
      ]);
    });
  });

  it("carries a shared filter onto a Start Event added next to it", async () => {
    const shared = filterOnTenant();
    let latest: Record<string, unknown> = withStartEvents(
      ["app/appointment.created"],
      { "app/appointment.created": shared }
    );
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Events", "Nightly sweep");

    await waitFor(() => {
      expect(rulesOf(latest).startFilters).toEqual({
        "app/appointment.created": shared,
        "ops/nightly.swept": shared,
      });
    });
  });

  // Stamping here would write a rule that reads false on every arrival of the
  // Event that was added, because the compiler guards each field for presence.
  it("leaves an added Event unfiltered when it lacks the filter's field", async () => {
    const onlyOnAppointments = filterOnTenant("patient.id");
    let latest: Record<string, unknown> = withStartEvents(
      ["app/appointment.created"],
      { "app/appointment.created": onlyOnAppointments }
    );
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Events", "Nightly sweep");

    await waitFor(() => {
      expect(rulesOf(latest).startEvents).toHaveLength(2);
    });
    expect(rulesOf(latest).startFilters).toEqual({
      "app/appointment.created": onlyOnAppointments,
    });
  });

  // With nothing in common there is no vocabulary one control could be written
  // in, and the group says so rather than offering an empty picker.
  it("offers no shared filter when the Start Events declare no common field", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={withStartEvents([
          "app/appointment.created",
          "ops/no.overlap",
        ])}
      />
    );

    expect(
      view
        .getByRole("button", { name: "Add a filter" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("drops the filter of a Start Event that was removed", async () => {
    let latest: Record<string, unknown> = withStartEvents([
      "app/appointment.created",
    ]);
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Add a filter" }));
    await waitFor(() => {
      expect(rulesOf(latest).startFilters).toBeTruthy();
    });

    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );

    await waitFor(() => {
      expect(rulesOf(latest).startFilters).toBeUndefined();
    });
  });
});

describe("LifecyclePanel cancel filters", () => {
  /** A finished one-rule filter over a path both fixture Events declare. */
  function filterOnTenant(path = "tenantId"): string {
    return JSON.stringify({
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group",
          logic: "and",
          conditions: [
            {
              id: "rule",
              field: path,
              fieldType: "string",
              operator: "equals",
              value: "t_1",
            },
          ],
        },
      ],
    });
  }

  function withCancelEvents(cancelEvents: string[], cancelFilters?: unknown) {
    return {
      lifecycleRules: {
        startEvents: [],
        cancelEvents,
        concurrency: "unlimited",
        cancelFilters,
      },
    } satisfies Record<string, unknown>;
  }

  it("explains the Cancel Filter decision before correlation and cancellation", () => {
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={withCancelEvents(["app/appointment.created"])}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "About Cancel Events" }));

    expect(
      view.getByText(
        "A cancel event stops matching active runs and sends them down the Canceled branch."
      )
    ).toBeTruthy();
    expect(
      view.getByText("A cancel filter limits which events can stop a run.")
    ).toBeTruthy();
    expect(
      view.getByText(
        "Matching uses the tracked Entity, or the correlation path when no Entity is tracked."
      )
    ).toBeTruthy();
  });

  it("writes one filter to every Cancel Event while they agree", async () => {
    let latest: Record<string, unknown> = withCancelEvents([
      "app/appointment.created",
      "ops/nightly.swept",
    ]);
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    expect(view.getAllByRole("button", { name: "Add a filter" })).toHaveLength(
      1
    );
    expect(
      view.getByRole("button", {
        name: "Use a different filter for each cancel event",
      })
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Add a filter" }));

    await waitFor(() => {
      const filters = rulesOf(latest).cancelFilters ?? {};
      expect(Object.keys(filters)).toEqual([
        "app/appointment.created",
        "ops/nightly.swept",
      ]);
      expect(filters["app/appointment.created"]).toBe(
        filters["ops/nightly.swept"]
      );
    });
  });

  it("carries a shared filter onto a compatible Cancel Event", async () => {
    const shared = filterOnTenant();
    let latest: Record<string, unknown> = withCancelEvents(
      ["app/appointment.created"],
      { "app/appointment.created": shared }
    );
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Cancel Events", "Nightly sweep");

    await waitFor(() => {
      expect(rulesOf(latest).cancelFilters).toEqual({
        "app/appointment.created": shared,
        "ops/nightly.swept": shared,
      });
    });
  });

  it("drops the filter of a Cancel Event that was removed", async () => {
    const filter = filterOnTenant();
    let latest: Record<string, unknown> = withCancelEvents(
      ["app/appointment.created"],
      { "app/appointment.created": filter }
    );
    const view = renderWithCatalog(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );

    await waitFor(() => {
      expect(rulesOf(latest).cancelFilters).toBeUndefined();
    });
  });
});
