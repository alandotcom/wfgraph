import { fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CONCURRENCY_OPTIONS,
  LifecyclePanel,
} from "#src/components/workflow/config/lifecycle-panel";
import { loadWorkflowGraphAtom } from "#src/lib/workflow-graph-store";
import {
  CANCEL_EVENTS_INTERIM_MESSAGE,
  type LifecycleRules,
  SCHEDULE_INTERIM_MESSAGE,
} from "@rova/shared/workflow/lifecycle-rules";
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

function waitNode(waitForEvents: string[]): WorkflowNode {
  return {
    id: "wait-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: "Wait", waitForEvents },
    },
  };
}

function rulesOf(config: Record<string, unknown>): LifecycleRules {
  return config.lifecycleRules as LifecycleRules;
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

    fireEvent.click(view.getByRole("button", { name: "Appointment created" }));

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
    const view = render(
      <LifecyclePanel
        config={{}}
        disabled={false}
        onUpdateConfig={onUpdateConfig}
      />
    );

    expect(onUpdateConfig).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Appointment created" }));

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
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
      const view = render(
        <ControlledPanel
          initialConfig={latest}
          onConfigChange={(config) => {
            latest = config;
          }}
        />
      );

      fireEvent.click(
        view.getByRole("button", { name: new RegExp(`^${label}`) })
      );

      await waitFor(() => {
        expect(rulesOf(latest).concurrency).toBe(value);
      });
    }
  );

  it("turns manual runs off and drops a Start Event chip", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["app/appointment.created"],
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

    fireEvent.click(view.getByRole("button", { name: "Appointment created" }));
    await waitFor(() => {
      expect(rulesOf(latest).startEvents).toEqual([]);
    });
  });
});

describe("LifecyclePanel Correlation Paths", () => {
  // The Event Author declared no path, so the builder supplies one, trimmed and
  // keyed by the Event it belongs to.
  it("commits a trimmed path on blur", async () => {
    let latest: Record<string, unknown> = {
      lifecycleRules: {
        startEvents: ["ops/nightly.swept"],
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

    const input = view.getByLabelText("ops/nightly.swept");
    fireEvent.change(input, { target: { value: " sweep.id " } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(rulesOf(latest).correlationPaths).toEqual({
        "ops/nightly.swept": "sweep.id",
      });
    });
  });

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
        startEvents: ["ops/nightly.swept"],
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

  // An Event carrying its own path needs nothing from the builder.
  it("asks for no path when the Event declares one", () => {
    const view = render(
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

    expect(view.queryByLabelText("app/appointment.created")).toBeNull();
  });

  // Unlimited compares no entities, so there is no value to compare and no input.
  it("asks for no path when nothing compares entities", () => {
    const view = render(
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

  // A Wait node matches by Entity Value too, so the Event it parks on is asked
  // about here, and the node asking is named because it is not the one the builder
  // is looking at.
  it("asks for a wait Event's path and says which node wants it", () => {
    const view = render(
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

    expect(view.getByLabelText("ops/nightly.swept")).toBeTruthy();
    expect(view.getByText("a Wait node parks on this")).toBeTruthy();
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
    const view = render(
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

  // The graph's Wait nodes are part of what a save is held to, so a wait on a
  // pathless Event surfaces here rather than only from the server.
  it("surfaces a wait Event's missing path as the save refusal", () => {
    const view = render(
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

    expect(view.getByText("This will not save")).toBeTruthy();
    expect(
      view.getByText(
        /^Event "ops\/nightly\.swept" declares no Correlation Path/
      )
    ).toBeTruthy();
  });
});

describe("LifecyclePanel interim placeholders", () => {
  // Both render the sentence a save answers with, so the two copies cannot drift.
  it("says why Cancel Events and a schedule are not available yet", () => {
    const view = render(<ControlledPanel />);

    expect(view.getByText(CANCEL_EVENTS_INTERIM_MESSAGE)).toBeTruthy();
    expect(view.getByText(SCHEDULE_INTERIM_MESSAGE)).toBeTruthy();
  });
});

describe("LifecyclePanel event URLs", () => {
  // Every namespaced Event name carries a slash, and an unencoded one addresses a
  // route that does not exist.
  it("encodes the Event name in the URL it offers", () => {
    const view = render(
      <ControlledPanel
        initialConfig={{
          lifecycleRules: {
            startEvents: ["app/appointment.created"],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        }}
      />
    );

    expect(
      view.getByText(/\/api\/events\/app%2Fappointment\.created$/)
    ).toBeTruthy();
    expect(
      view.getByLabelText("Copy the URL for app/appointment.created")
    ).toBeTruthy();
  });
});
