import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { type ReactElement, useState } from "react";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  loadWorkflowGraphAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import {
  type ActionMetadata,
  type EventMetadata,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { TemplateBadgeInput } from "./template-badge-input";
import { TemplateBadgeTextarea } from "./template-badge-textarea";

// The entry node offers the payload fields of the Events its rules start on, and
// an action node offers its own catalog entry's output fields, so a case that
// wants either says what the app declares by writing this object.
type MutableCatalog = {
  events: EventMetadata[];
  actions: ActionMetadata[];
  integrations: ExtensionCatalog["integrations"];
};

const surface: MutableCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

beforeEach(() => {
  surface.events = [];
  surface.actions = [];
});

function renderWithCatalog(ui: ReactElement) {
  return render(
    <ExtensionCatalogProvider value={surface as ExtensionCatalog}>
      {ui}
    </ExtensionCatalogProvider>
  );
}

const APPOINTMENT_CREATED: EventMetadata = {
  name: "app/appointment.created",
  label: "Appointment created",
  // Declared in an order no target wants, so a case asserting the menu's order is
  // asserting the ranking rather than the schema.
  payloadFields: [
    { path: "patientName", description: "Patient name", type: "string" },
    {
      path: "occurredAt",
      description: "When it happened",
      type: "timestamp",
    },
    { path: "amountCents", description: "Amount in cents", type: "number" },
  ],
};

const LIFECYCLE_TEMPLATE = "{{@lifecycle_1:Webhook.occurredAt}}";
const SEND_MESSAGE_STATUS_TEMPLATE = "{{@action_1:Send Message.status}}";

const SEND_MESSAGE_ACTION: ActionMetadata = {
  id: "custom/send-message",
  label: "Send Message",
  description: "Sends a message",
  category: "Custom",
  configFields: [],
  outputFields: [
    { path: "status", description: "Delivery status", type: "number" },
  ],
};

async function seedTemplateContext(selectedNodeId = "wait_1") {
  const store = getDefaultStore();
  surface.events = [APPOINTMENT_CREATED];
  const nodes: WorkflowNode[] = [
    {
      id: "lifecycle_1",
      position: { x: 0, y: 0 },
      data: {
        label: "Webhook",
        type: "lifecycle",
        config: {
          lifecycleRules: {
            startEvents: [APPOINTMENT_CREATED.name],
            cancelEvents: [],
            concurrency: "unlimited",
          },
        },
      },
    },
    {
      id: "wait_1",
      position: { x: 240, y: 0 },
      data: {
        label: "Wait",
        type: "action",
        config: { actionType: "Wait" },
      },
      selected: selectedNodeId === "wait_1",
    },
  ];
  const edges: WorkflowEdge[] = [
    {
      id: "edge_1",
      source: "lifecycle_1",
      sourceHandle: LIFECYCLE_STARTED_HANDLE,
      target: "wait_1",
    },
  ];

  store.set(loadWorkflowGraphAtom, { nodes, edges });
}

/**
 * The first row of the menu, which for a timestamp-typed field is the payload's
 * timestamp: ranking puts it ahead of the plain string beside it.
 */
function findTimestampOption(): HTMLElement {
  const option = screen.queryAllByRole("option").at(0);

  if (!(option instanceof HTMLElement)) {
    throw new Error("Failed to find autocomplete option");
  }

  return option;
}

/** The menu as it reads, top to bottom. */
function menuRows(): string[] {
  return screen
    .queryAllByRole("option")
    .map((option) => option.textContent ?? "");
}

function findAutocompleteOptionByText(text: string): HTMLElement {
  const options = screen.queryAllByRole("option");
  const match = options.find((option) => option.textContent?.includes(text));

  if (!match) {
    throw new Error(`Failed to find autocomplete option: ${text}`);
  }

  return match;
}

function typeAtSymbol(textbox: HTMLElement) {
  fireEvent.focus(textbox);
  textbox.textContent = "@";
  fireEvent.input(textbox);
}

function ControlledTemplateBadgeInput({
  onValueChange,
}: {
  onValueChange: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <TemplateBadgeInput
      fieldType="timestamp"
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange(nextValue);
      }}
      value={value}
    />
  );
}

function DurationTemplateBadgeInput() {
  return (
    <TemplateBadgeInput fieldType="duration" onChange={() => {}} value="" />
  );
}

function ControlledTemplateBadgeInputWithNodeContext({
  currentNodeId,
  onValueChange,
}: {
  currentNodeId: string;
  onValueChange: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <TemplateBadgeInput
      currentNodeId={currentNodeId}
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange(nextValue);
      }}
      value={value}
    />
  );
}

function PlaceholderTemplateBadgeInput({
  onValueChange,
}: {
  onValueChange: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <TemplateBadgeInput
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange(nextValue);
      }}
      placeholder="Enter a subject line"
      value={value}
    />
  );
}

function UncontrolledTemplateBadgeInput({ value }: { value: string }) {
  return (
    <TemplateBadgeInput
      fieldType="timestamp"
      onChange={() => {}}
      value={value}
    />
  );
}

function ControlledTemplateBadgeTextarea({
  onValueChange,
}: {
  onValueChange: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <TemplateBadgeTextarea
      fieldType="timestamp"
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange(nextValue);
      }}
      value={value}
    />
  );
}

describe("Template badge autocomplete", () => {
  beforeEach(async () => {
    await seedTemplateContext();
  });

  it("renders a pill immediately after mouse selection in TemplateBadgeInput", async () => {
    let latestValue = "";
    const view = renderWithCatalog(
      <ControlledTemplateBadgeInput
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );

    const textbox = view.getByRole("textbox");
    typeAtSymbol(textbox);

    const option = await waitFor(() => findTimestampOption());
    fireEvent.mouseDown(option);

    await waitFor(() => {
      expect(latestValue).toBe(LIFECYCLE_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("Webhook.occurredAt");
    });

    expect(document.activeElement).toBe(textbox);
  });

  it("renders a pill immediately after keyboard Enter selection", async () => {
    let latestValue = "";
    const view = renderWithCatalog(
      <ControlledTemplateBadgeInput
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );

    const textbox = view.getByRole("textbox");
    typeAtSymbol(textbox);

    await waitFor(() => findTimestampOption());
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => {
      expect(latestValue).toBe(LIFECYCLE_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("Webhook.occurredAt");
    });
  });

  it("renders a pill immediately after mouse selection in TemplateBadgeTextarea", async () => {
    let latestValue = "";
    const view = renderWithCatalog(
      <ControlledTemplateBadgeTextarea
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );

    const textbox = view.getByRole("textbox");
    typeAtSymbol(textbox);

    const option = await waitFor(() => findTimestampOption());
    fireEvent.mouseDown(option);

    await waitFor(() => {
      expect(latestValue).toBe(LIFECYCLE_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("Webhook.occurredAt");
    });

    expect(document.activeElement).toBe(textbox);
  });

  it("offers a duration field only the durations upstream", async () => {
    // A patient's name reaches `parseDurationMs` as a run that fails, so the
    // menu leaves out everything the target cannot read. What an Event Author
    // declared as a length of time is what stands.
    surface.events = [
      {
        ...APPOINTMENT_CREATED,
        payloadFields: [
          ...APPOINTMENT_CREATED.payloadFields,
          {
            path: "leadTime",
            description: "How long before",
            type: "duration",
          },
        ],
      },
    ];
    const view = renderWithCatalog(<DurationTemplateBadgeInput />);
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => {
      expect(menuRows()).toEqual(["Webhook.leadTimeHow long before"]);
    });
  });

  it("says why a duration field has nothing to offer", async () => {
    const view = renderWithCatalog(<DurationTemplateBadgeInput />);
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "No field upstream is a duration"
      );
    });
    expect(menuRows()).toEqual([]);
  });

  it("offers a date field only the instants upstream", async () => {
    const view = renderWithCatalog(
      <ControlledTemplateBadgeInput onValueChange={() => {}} />
    );
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => {
      expect(menuRows()).toEqual(["Webhook.occurredAtWhen it happened"]);
    });
  });

  it("leaves the second line off a field its author never described", async () => {
    // The path is already the row's first line, so a title-cased echo of the key
    // below it would be a line saying nothing twice.
    surface.events = [
      {
        ...APPOINTMENT_CREATED,
        payloadFields: [
          {
            path: "leadTime",
            description: "How long before",
            type: "duration",
          },
          { path: "grace", type: "duration" },
        ],
      },
    ];
    const view = renderWithCatalog(<DurationTemplateBadgeInput />);
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => {
      expect(menuRows()).toEqual([
        "Webhook.leadTimeHow long before",
        "Webhook.grace",
      ]);
    });
  });

  // The menu shows about seven rows, so a highlight arrowed past the fold has to
  // be scrolled to. happy-dom implements no scrollIntoView, so the stub is both
  // the spy and the implementation.
  it("scrolls the highlighted row into view as the keyboard walks past it", async () => {
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView
    );

    const view = renderWithCatalog(
      <PlaceholderTemplateBadgeInput onValueChange={() => {}} />
    );
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => expect(menuRows()).toHaveLength(3));

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });

    await waitFor(() => {
      const scrolled = scrollIntoView.mock.instances.at(-1);
      expect(scrolled).toBeInstanceOf(HTMLElement);
      expect((scrolled as HTMLElement).textContent).toContain(
        "Webhook.amountCents"
      );
    });

    vi.restoreAllMocks();
  });

  it("uses currentNodeId for autocomplete when no node is selected in the canvas", async () => {
    surface.actions = [SEND_MESSAGE_ACTION];
    const store = getDefaultStore();
    const nodes: WorkflowNode[] = [
      {
        id: "lifecycle_1",
        position: { x: 0, y: 0 },
        data: {
          label: "Webhook",
          type: "lifecycle",
        },
      },
      {
        id: "action_1",
        position: { x: 240, y: 0 },
        data: {
          label: "Send Message",
          type: "action",
          config: { actionType: "custom/send-message" },
        },
      },
      {
        id: "condition_1",
        position: { x: 480, y: 0 },
        data: {
          label: "Condition",
          type: "action",
          config: { actionType: "Condition" },
        },
      },
    ];
    const edges: WorkflowEdge[] = [
      { id: "edge_1", source: "lifecycle_1", target: "action_1" },
      { id: "edge_2", source: "action_1", target: "condition_1" },
    ];

    store.set(loadWorkflowGraphAtom, { nodes, edges });

    let latestValue = "";
    const view = renderWithCatalog(
      <ControlledTemplateBadgeInputWithNodeContext
        currentNodeId="condition_1"
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );

    const textbox = view.getByRole("textbox");
    typeAtSymbol(textbox);

    const option = await waitFor(() =>
      findAutocompleteOptionByText("Send Message.status")
    );
    fireEvent.mouseDown(option);

    await waitFor(() => {
      expect(latestValue).toBe(SEND_MESSAGE_STATUS_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("Send Message.status");
    });
  });

  it("stays closed for the @ inside a badge already placed", async () => {
    const view = renderWithCatalog(
      <ControlledTemplateBadgeInput onValueChange={() => {}} />
    );

    const textbox = view.getByRole("textbox");
    typeAtSymbol(textbox);
    fireEvent.mouseDown(await waitFor(() => findTimestampOption()));
    await waitFor(() => {
      expect(textbox.querySelector("[data-template]")).toBeTruthy();
    });

    // Every stored token carries an @ of its own, and it is not an invitation
    // to pick a second field. An open menu holds the arrow and Escape keys.
    textbox.append(document.createTextNode("abc"));
    fireEvent.input(textbox);

    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(true);
  });

  it("leaves the keys alone while it has no row to show", async () => {
    const view = renderWithCatalog(
      <ControlledTemplateBadgeInput onValueChange={() => {}} />
    );

    const textbox = view.getByRole("textbox");
    fireEvent.focus(textbox);
    textbox.textContent = "@zzz";
    fireEvent.input(textbox);

    await waitFor(() => expect(menuRows()).toHaveLength(0));
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(true);
  });
});

describe("Template badge rendering", () => {
  beforeEach(async () => {
    await seedTemplateContext();
  });

  it("relabels a badge when its node is renamed", async () => {
    // A badge shows the node's current label, but the value it stands for is a
    // token holding the label the token was written against. Renaming a node
    // produces no DOM event, so this is the one thing the editor genuinely has
    // to re-render in response to a React state change.
    const view = renderWithCatalog(
      <UncontrolledTemplateBadgeInput value={LIFECYCLE_TEMPLATE} />
    );

    const textbox = view.getByRole("textbox");
    await waitFor(() => {
      expect(textbox.querySelector("[data-template]")?.textContent).toBe(
        "Webhook.occurredAt"
      );
    });

    // A rename is a store write with no DOM event behind it, so the re-render
    // it causes belongs to the test rather than to a browser. Written outside
    // `act` it lands whenever the machine gets to it, which on a slow runner is
    // after the case has ended.
    act(() => {
      getDefaultStore().set(updateNodeDataAtom, {
        id: "lifecycle_1",
        data: { label: "Incoming Hook" },
      });
    });

    await waitFor(() => {
      expect(textbox.querySelector("[data-template]")?.textContent).toBe(
        "Incoming Hook.occurredAt"
      );
    });
  });

  it("renders a value the parent supplies while the field is not focused", async () => {
    const view = renderWithCatalog(<UncontrolledTemplateBadgeInput value="" />);
    const textbox = view.getByRole("textbox");

    view.rerender(
      <ExtensionCatalogProvider value={surface as ExtensionCatalog}>
        <UncontrolledTemplateBadgeInput value={LIFECYCLE_TEMPLATE} />
      </ExtensionCatalogProvider>
    );

    await waitFor(() => {
      expect(textbox.querySelector("[data-template]")?.textContent).toBe(
        "Webhook.occurredAt"
      );
    });
  });

  it("reads a badge back as the raw token it stands for", async () => {
    let latestValue = "";
    const view = renderWithCatalog(
      <ControlledTemplateBadgeInput
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );

    const textbox = view.getByRole("textbox");
    typeAtSymbol(textbox);

    const option = await waitFor(() => findTimestampOption());
    fireEvent.mouseDown(option);

    await waitFor(() => expect(latestValue).toBe(LIFECYCLE_TEMPLATE));

    // Typing after the badge appends to the token, rather than replacing the
    // badge with the label the user can see.
    textbox.append(document.createTextNode(" done"));
    fireEvent.input(textbox);

    await waitFor(() => {
      expect(latestValue).toBe(`${LIFECYCLE_TEMPLATE} done`);
    });
  });
});

describe("Template badge editing", () => {
  beforeEach(async () => {
    await seedTemplateContext();
  });

  it("does not read its own placeholder back as the value", async () => {
    // An empty unfocused field shows prompt text, which lives in the same
    // contentEditable as anything the user types.
    let latestValue = "";
    const view = renderWithCatalog(
      <PlaceholderTemplateBadgeInput
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );

    const textbox = view.getByRole("textbox");
    fireEvent.focus(textbox);
    textbox.append(document.createTextNode("H"));
    fireEvent.input(textbox);

    await waitFor(() => expect(latestValue).toBe("H"));
  });

  it("keeps what is being typed when a node is renamed", async () => {
    // Typing flows out to the node being configured, so every keystroke
    // produces a new node array. Redrawing the badges on each one would rebuild
    // the DOM under the caret.
    let latestValue = "";
    const view = renderWithCatalog(
      <PlaceholderTemplateBadgeInput
        onValueChange={(value) => {
          latestValue = value;
        }}
      />
    );

    const textbox = view.getByRole("textbox");
    fireEvent.focus(textbox);
    textbox.textContent = "abc";
    fireEvent.input(textbox);
    await waitFor(() => expect(latestValue).toBe("abc"));

    act(() => {
      getDefaultStore().set(updateNodeDataAtom, {
        id: "lifecycle_1",
        data: { label: "Renamed" },
      });
    });

    await waitFor(() => expect(textbox.textContent).toBe("abc"));
    expect(latestValue).toBe("abc");
  });
});

describe("Template badge autocomplete node rows", () => {
  beforeEach(async () => {
    await seedTemplateContext();
  });

  it("leaves out a node that declares no output of its own", async () => {
    // A Condition or an Event Split routes the run and produces nothing to
    // address, so the whole-node row would name the engine's own bookkeeping.
    surface.actions = [
      {
        id: "Event Split",
        label: "Event Split",
        description: "",
        category: "System",
        configFields: [],
        outputFields: [],
      },
      SEND_MESSAGE_ACTION,
    ];
    const store = getDefaultStore();
    store.set(loadWorkflowGraphAtom, {
      nodes: [
        {
          id: "lifecycle_1",
          position: { x: 0, y: 0 },
          data: {
            label: "Webhook",
            type: "lifecycle",
            config: {
              lifecycleRules: {
                startEvents: [APPOINTMENT_CREATED.name],
                cancelEvents: [],
                concurrency: "unlimited",
              },
            },
          },
        },
        {
          id: "split_1",
          position: { x: 0, y: 100 },
          data: {
            label: "Event Split",
            type: "action",
            config: { actionType: "Event Split" },
          },
        },
        {
          id: "send_1",
          position: { x: 0, y: 200 },
          data: {
            label: "Send Message",
            type: "action",
            config: { actionType: "custom/send-message" },
          },
        },
        {
          id: "wait_1",
          position: { x: 0, y: 300 },
          data: {
            label: "Wait",
            type: "action",
            config: { actionType: "Wait" },
          },
          selected: true,
        },
      ],
      edges: [
        {
          id: "e1",
          source: "lifecycle_1",
          sourceHandle: LIFECYCLE_STARTED_HANDLE,
          target: "split_1",
        },
        {
          id: "e2",
          source: "split_1",
          sourceHandle: "event:app/appointment.created",
          target: "send_1",
        },
        { id: "e3", source: "send_1", target: "wait_1" },
      ],
    });

    const view = renderWithCatalog(
      <PlaceholderTemplateBadgeInput onValueChange={() => {}} />
    );
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => {
      // The node that does produce something keeps its whole-output row.
      expect(menuRows()).toContain("Send Message");
    });
    expect(menuRows()).not.toContain("Event Split");
  });
});
