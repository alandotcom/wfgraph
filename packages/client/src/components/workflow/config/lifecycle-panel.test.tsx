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
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

const testCatalog: ExtensionCatalog = {
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
      ],
    },
    {
      name: "ops/nightly.swept",
      label: "Nightly sweep",
      payloadFields: [
        { path: "sweep.id", type: "string" },
        { path: "sweep.count", type: "number" },
      ],
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

/**
 * Open the panel's controls.
 *
 * The node's configuration is one section with one Edit button, so this opens
 * all three groups at once: a test wanting the Concurrency radios and the Start
 * Event picker together presses this once, not twice.
 */
function editRules(view: RenderResult) {
  fireEvent.click(view.getByRole("button", { name: "Edit Lifecycle Rules" }));
}

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
 * the list through events happy-dom does not deliver whole, and the keyboard path
 * is the one a builder filtering a long list takes anyway. The option is looked
 * up through the input's own `aria-controls` rather than the page's whole
 * role="option" set, since two comboboxes can be open on this screen at once.
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
  return view.getByLabelText(eventName);
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

    editRules(view);
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

    // Opening a section is not an edit either: the panel is now two modes deep
    // and neither of the two doors writes anything on the way through.
    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

      editRules(view);
      fireEvent.click(
        view.getByRole("radio", { name: new RegExp(`^${label}`) })
      );

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

    editRules(view);
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

    expect(view.queryByText(/described by nothing/)).toBeNull();

    editRules(view);
    fireEvent.click(
      view.getByRole("button", { name: "Remove app/appointment.created" })
    );

    // A consequence of the configuration rather than an explanation of a
    // control, so it stays in the column and shows in view mode.
    await waitFor(() => {
      expect(view.getByText(/described by nothing/)).toBeTruthy();
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

    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

    expect(view.queryByText("This will not save")).toBeNull();

    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

    editRules(view);
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

    editRules(view);
    expect(pathChoices(view, "app/appointment.created")).toEqual([
      "appointment.id",
      "appointment.duration",
      "patient.id",
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

    editRules(view);
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
    // One Edit opens the whole configuration, which is how one panel shows the
    // switch and the field it brings with it.
    editRules(view);
    fireEvent.click(view.getByRole("radio", { name: /^Newest wins/ }));
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
    fireEvent.click(view.getByRole("radio", { name: /^Unlimited/ }));
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

    editRules(view);
    expect(pathInForce(view, "app/appointment.created")).toBe("appointment.id");
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(view.queryByText("This will not save")).toBeNull();
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

    editRules(view);
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

    editRules(view);
    expect(view.getByLabelText("ops/nightly.swept")).toBeTruthy();
    expect(view.getByText("Nightly sweep")).toBeTruthy();
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

    editRules(view);
    expect(view.queryByLabelText("ops/nightly.swept")).toBeNull();
    expect(view.queryByText("This will not save")).toBeNull();
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

    expect(view.getByText("This will not save")).toBeTruthy();
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

describe("LifecyclePanel view mode", () => {
  const CONFIGURED: Record<string, unknown> = {
    lifecycleRules: {
      startEvents: ["app/appointment.created"],
      cancelEvents: ["ops/nightly.swept"],
      concurrency: "newest-wins",
      allowManualStart: true,
      correlationPaths: { "ops/nightly.swept": "sweep.id" },
    },
  };

  // What the panel is for, most of the time, is reading back what it was set
  // to. Every value is a line of text and no control is mounted until asked
  // for.
  it("reads the configuration back as text", () => {
    const view = renderWithCatalog(
      <ControlledPanel initialConfig={CONFIGURED} />
    );

    expect(view.getByText("Appointment created")).toBeTruthy();
    expect(view.getByText("appointment.id")).toBeTruthy();
    expect(view.getByText("Nightly sweep")).toBeTruthy();
    expect(view.getByText("sweep.id")).toBeTruthy();
    expect(view.getByText("Newest wins")).toBeTruthy();
    expect(view.getByText("Allowed")).toBeTruthy();

    expect(view.queryByLabelText("Start Events")).toBeNull();
    expect(view.queryAllByRole("radio")).toEqual([]);
  });

  // Edit swaps every group at once and Done swaps them all back: the panel is
  // one configuration in one of two modes, not three blocks a builder opens and
  // closes one at a time.
  it("switches the whole section between its two modes", () => {
    const view = renderWithCatalog(
      <ControlledPanel initialConfig={CONFIGURED} />
    );

    editRules(view);
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

  // The regression this section exists to prevent. Each group used to carry its
  // own Edit button, so a Lifecycle node offered three of them for one
  // configuration.
  it("offers one Edit button for the whole configuration", () => {
    const view = renderWithCatalog(
      <ControlledPanel initialConfig={CONFIGURED} />
    );

    expect(view.getAllByRole("button", { name: /^Edit / })).toHaveLength(1);

    editRules(view);
    expect(
      view.getAllByRole("button", { name: /^Done editing / })
    ).toHaveLength(1);
  });

  // A panel whose writes would be refused offers no Edit at all, so view mode
  // never implies an edit a non-owner cannot make.
  it("gives a disabled panel no way into edit mode", () => {
    const view = renderWithCatalog(
      <LifecyclePanel config={CONFIGURED} disabled onUpdateConfig={vi.fn()} />
    );

    expect(view.queryAllByRole("button", { name: /^Edit / })).toEqual([]);
    expect(view.getByText("Newest wins")).toBeTruthy();
  });

  // The prose that used to sit under the controls is behind the icon beside the
  // label, and it opens on a click rather than on hover: the content is long
  // enough to want to stay open, and hover does not exist on touch.
  it("opens a section's help on a click", () => {
    const view = renderWithCatalog(
      <ControlledPanel initialConfig={CONFIGURED} />
    );

    expect(
      view.queryByText(/A run starts when one of these Events/)
    ).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "About Start Events" }));

    expect(
      view.getByText(/A run starts when one of these Events/)
    ).toBeTruthy();
  });

  // Chosen option first, because a builder opening this has already chosen and
  // the sentence describing what their workflow does now is the one they want.
  it("puts the concurrency setting in force at the top of its help", () => {
    const view = renderWithCatalog(
      <ControlledPanel initialConfig={CONFIGURED} />
    );

    fireEvent.click(view.getByRole("button", { name: "About Concurrency" }));

    const described = view
      .getAllByText(
        /supersedes the ones already going|Every Event starts its own run/
      )
      .map((node) => node.textContent ?? "");
    expect(described.at(0)).toContain("supersedes the ones already going");
  });
});
