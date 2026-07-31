import {
  fireEvent,
  render,
  type RenderResult,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CONCURRENCY_OPTIONS,
  LifecyclePanel,
} from "#src/components/workflow/config/lifecycle-panel";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import type { LifecycleRules } from "@rova/shared/workflow/lifecycle-rules";
import type { WorkflowNode } from "@rova/shared/workflow/types";

// The Events a panel offers come from the server's catalog. One declares its own
// Correlation Path and one leaves it to the builder, which is the difference the
// path input exists for.
vi.mock("#src/lib/extensions", () => ({
  getExtensionCatalog: () => ({
    events: [
      {
        name: "app/appointment.created",
        label: "Appointment created",
        correlationPath: "appointment.id",
        payloadFields: [],
      },
      {
        name: "ops/nightly.swept",
        label: "Nightly sweep",
        payloadFields: [],
      },
    ],
    actions: [],
    integrations: [],
  }),
}));

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

  return <JotaiProvider store={store}>{children}</JotaiProvider>;
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

describe("LifecyclePanel", () => {
  // The moment rules exist they are held to the start-source rule, so the first
  // write has to carry a start source or it refuses the save that wrote it.
  it("carries manual starts into the rules it first writes", async () => {
    let latest: Record<string, unknown> = {};
    const view = render(
      <ControlledPanel
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Event", "Appointment created");

    await waitFor(() => {
      expect(rulesOf(latest)).toEqual({
        startEvent: "app/appointment.created",
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
    const view = render(
      <LifecyclePanel
        config={{}}
        disabled={false}
        onUpdateConfig={onUpdateConfig}
      />
    );

    expect(onUpdateConfig).not.toHaveBeenCalled();

    chooseEvent(view, "Start Event", "Appointment created");

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
  });

  // The clear button only makes sense once there is a selection to clear;
  // Base UI unmounts it until then.
  it("shows no clear button while the Start Event is unset", () => {
    const view = render(
      <LifecyclePanel config={{}} disabled={false} onUpdateConfig={vi.fn()} />
    );

    expect(
      view.queryByRole("button", { name: "Clear the selection" })
    ).toBeNull();
  });

  // The trigger button is the pointer path into a picker's full list, beside
  // the keyboard path `chooseEvent` drives everywhere else in this file.
  it("opens the Start Event picker from its trigger button", () => {
    const view = render(
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
    const view = render(
      <ControlledPanel
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Event", "ops/nightly");

    await waitFor(() => {
      expect(rulesOf(latest).startEvent).toBe("ops/nightly.swept");
    });
  });

  // One Start Event, so a second pick is the choice rather than a second entry.
  it("replaces the Start Event rather than adding to it", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvent: "app/appointment.created",
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    chooseEvent(view, "Start Event", "Nightly sweep");

    await waitFor(() => {
      expect(rulesOf(latest).startEvent).toBe("ops/nightly.swept");
    });
  });

  it.each(CONCURRENCY_OPTIONS.map((option) => [option.label, option.value]))(
    "writes the %s setting the builder picked",
    async (label, value) => {
      let latest: Record<string, unknown> = {
        lifecycleRules: {
          startEvent: "app/appointment.created",
          cancelEvents: [],
          concurrency: value === "unlimited" ? "newest-wins" : "unlimited",
        },
      };
      const view = render(
        <ControlledPanel
          initialConfig={latest}
          onConfigChange={(config) => {
            latest = config;
          }}
        />
      );

      fireEvent.click(
        view.getByRole("radio", { name: new RegExp(`^${label}`) })
      );

      await waitFor(() => {
        expect(rulesOf(latest).concurrency).toBe(value);
      });
    }
  );

  it("turns manual runs off and clears the Start Event", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvent: "app/appointment.created",
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = render(
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

    fireEvent.click(view.getByRole("button", { name: "Clear the selection" }));
    await waitFor(() => {
      expect(rulesOf(latest).startEvent).toBeUndefined();
    });
  });

  it("says a manual run's payload is described by nothing", async () => {
    // What the editor can offer downstream comes off the Start Event, so a
    // workflow with none leaves the picker empty. The panel says so rather than
    // leaving that silence to be read as a missing feature.
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvent: "app/appointment.created",
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    expect(view.queryByText(/described by nothing/)).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Clear the selection" }));

    await waitFor(() => {
      expect(view.getByText(/described by nothing/)).toBeTruthy();
    });
  });
});

describe("LifecyclePanel Cancel Events", () => {
  it("writes a cancel Event pick to lifecycleRules.cancelEvents", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = render(
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
        cancelEvents: ["app/appointment.created", "ops/nightly.swept"],
        concurrency: "unlimited",
        allowManualStart: true,
        correlationPaths: { "ops/nightly.swept": "sweep.id" },
      },
    };
    const view = render(
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
  // Event gets an editable one: an Event declaring the wrong field for this
  // workflow would otherwise be a rule the builder can read and cannot fix.
  it("gives each chosen Event an editable path, defaulted to its declaration", () => {
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            cancelEvents: ["app/appointment.created", "ops/nightly.swept"],
            concurrency: "unlimited",
            allowManualStart: true,
          },
        }}
      />
    );

    const declared = view.getByLabelText(
      "app/appointment.created"
    ) as HTMLInputElement;
    expect(declared.value).toBe("");
    expect(declared.placeholder).toBe("appointment.id");

    expect(
      (view.getByLabelText("ops/nightly.swept") as HTMLInputElement).value
    ).toBe("");
  });

  it("shows the builder's override in the field", () => {
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            cancelEvents: ["ops/nightly.swept"],
            concurrency: "unlimited",
            allowManualStart: true,
            correlationPaths: { "ops/nightly.swept": "sweep.id" },
          },
        }}
      />
    );

    expect(
      (view.getByLabelText("ops/nightly.swept") as HTMLInputElement).value
    ).toBe("sweep.id");
  });

  // The Event Author's declaration is a default the workflow may disagree with,
  // and a builder who cannot type over it has to ask for a second Event.
  it("writes an override for an Event that declares its own path", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        cancelEvents: ["app/appointment.created"],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    fireEvent.change(view.getByLabelText("app/appointment.created"), {
      target: { value: "patient.id" },
    });

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
        startEvent: "app/appointment.created",
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    expect(view.queryByText("This will not save")).toBeNull();

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
  // The Event Author declared no path, so the builder supplies one, trimmed and
  // keyed by the Event it belongs to.
  it("commits a trimmed path as it is typed", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvent: "ops/nightly.swept",
        cancelEvents: [],
        concurrency: "newest-wins",
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    // No blur: Cmd+S is a capture-phase listener the focused field never sees,
    // so a value committed only on blur is a value the save does not carry.
    fireEvent.change(view.getByLabelText("ops/nightly.swept"), {
      target: { value: " sweep.id " },
    });

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toEqual({
        "ops/nightly.swept": "sweep.id",
      });
    });
  });

  it("clears one path and keeps the others", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvent: "ops/nightly.swept",
        cancelEvents: [],
        concurrency: "newest-wins",
        correlationPaths: {
          "ops/nightly.swept": "sweep.id",
          "vendor/thing.happened": "thing.id",
        },
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    const input = view.getByLabelText("ops/nightly.swept");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);

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
        startEvent: "ops/nightly.swept",
        cancelEvents: [],
        concurrency: "newest-wins",
        correlationPaths: { "ops/nightly.swept": "sweep.id" },
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    const input = view.getByLabelText("ops/nightly.swept");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toBeUndefined();
    });
  });

  // F1's repro, entirely through the panel: an override written while
  // Concurrency compares must not survive a switch back to Unlimited with no
  // Cancel Event to keep it alive. Before the prune, the field's disappearance
  // was cosmetic and the override kept governing every run in silence.
  it("prunes a stale start override on a switch back to Unlimited with no cancels", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvent: "app/appointment.created",
        cancelEvents: [],
        concurrency: "unlimited",
        allowManualStart: true,
      },
    };
    const view = render(
      <ControlledPanel
        initialConfig={latest}
        onConfigChange={(config) => {
          latest = config;
        }}
      />
    );

    // Concurrency now compares, so the field appears; the builder overrides it.
    fireEvent.click(view.getByRole("radio", { name: /^Newest wins/ }));
    await waitFor(() => {
      expect(rulesOf(latest).concurrency).toBe("newest-wins");
    });

    fireEvent.change(view.getByLabelText("app/appointment.created"), {
      target: { value: "patient.id" },
    });
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

  // An Event carrying its own path still gets a field, seeded with nothing: the
  // declaration is what an empty field means, so the panel writes no override for
  // a builder who only opened it.
  it("offers a field for a Start Event that declares its own path", () => {
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvent: "app/appointment.created",
            cancelEvents: [],
            concurrency: "newest-wins",
          },
        }}
      />
    );

    const input = view.getByLabelText(
      "app/appointment.created"
    ) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("appointment.id");
    expect(view.queryByText("This will not save")).toBeNull();
  });

  // Unlimited compares no entities, so there is no value to compare and no input.
  it("asks for no path when nothing compares entities", () => {
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvent: "ops/nightly.swept",
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
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            cancelEvents: ["ops/nightly.swept"],
            concurrency: "unlimited",
            allowManualStart: true,
          },
        }}
      />
    );

    expect(view.getByLabelText("ops/nightly.swept")).toBeTruthy();
    expect(view.getByText("Nightly sweep")).toBeTruthy();
  });

  // A Wait Subscription carries its own match expression, so nothing a Wait node
  // parks on is asked about here. The rules answer for start and cancel roles.
  it("asks nothing on account of a Wait node", () => {
    const view = render(
      withGraph(
        [waitNode(["ops/nightly.swept"])],
        <ControlledPanel
          initialConfig={{
            lifecycleRules: {
              startEvent: "app/appointment.created",
              cancelEvents: [],
              concurrency: "unlimited",
              allowManualStart: true,
            },
          }}
        />
      )
    );

    expect(view.queryByLabelText("ops/nightly.swept")).toBeNull();
    expect(view.queryByText("This will not save")).toBeNull();
  });
});

describe("LifecyclePanel refusals", () => {
  // The panel runs the same check the save is refused by, so the sentence is
  // there before a builder waits for a toast to tell them.
  it("shows the refusal a save would answer with", () => {
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
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
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvent: "app/appointment.moved",
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
