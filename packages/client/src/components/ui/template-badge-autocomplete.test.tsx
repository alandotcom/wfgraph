import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { useState } from "react";
import {
  loadWorkflowGraphAtom,
  updateNodeDataAtom,
} from "#src/lib/workflow-graph-store";
import {
  type ActionMetadata,
  emptyExtensionCatalog,
  type EventMetadata,
} from "@rova/shared/extensions/catalog";
import { LIFECYCLE_STARTED_HANDLE } from "@rova/shared/workflow/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";
import { TemplateBadgeInput } from "./template-badge-input";
import { TemplateBadgeTextarea } from "./template-badge-textarea";

// The entry node offers the payload fields of the Events its rules start on, and
// an action node offers its own catalog entry's output fields, so a case that
// wants either says what the app declares. `vi.hoisted` is what lets the mock
// factory below read this.
const surface = vi.hoisted(() => ({
  events: [] as EventMetadata[],
  actions: [] as ActionMetadata[],
}));

vi.mock("#src/lib/extensions", () => ({
  getExtensionCatalog: () => ({
    ...emptyExtensionCatalog,
    events: surface.events,
    actions: surface.actions,
  }),
}));

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
      format: "timestamp",
    },
    { path: "amountCents", description: "Amount in cents", type: "number" },
  ],
};

const TRIGGER_TEMPLATE = "{{@trigger_1:Webhook.occurredAt}}";
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

function seedTemplateContext(selectedNodeId = "wait_1") {
  const store = getDefaultStore();
  surface.events = [APPOINTMENT_CREATED];
  const nodes: WorkflowNode[] = [
    {
      id: "trigger_1",
      position: { x: 0, y: 0 },
      data: {
        label: "Webhook",
        type: "trigger",
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
      source: "trigger_1",
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
  const option = document.body.querySelector(".cursor-pointer");

  if (!(option instanceof HTMLElement)) {
    throw new Error("Failed to find autocomplete option");
  }

  return option;
}

/** The menu as it reads, top to bottom. */
function menuRows(): string[] {
  return Array.from(document.body.querySelectorAll(".cursor-pointer")).map(
    (option) => option.textContent ?? ""
  );
}

function findAutocompleteOptionByText(text: string): HTMLElement {
  const options = Array.from(
    document.body.querySelectorAll(".cursor-pointer")
  ).filter((option): option is HTMLElement => option instanceof HTMLElement);
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
  return <TemplateBadgeInput fieldType="duration" onChange={() => {}} value="" />;
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
  return <TemplateBadgeInput fieldType="timestamp" onChange={() => {}} value={value} />;
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
  beforeEach(() => {
    seedTemplateContext();
  });

  it("renders a pill immediately after mouse selection in TemplateBadgeInput", async () => {
    let latestValue = "";
    const view = render(
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
      expect(latestValue).toBe(TRIGGER_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("Webhook.occurredAt");
    });

    expect(document.activeElement).toBe(textbox);
  });

  it("renders a pill immediately after keyboard Enter selection", async () => {
    let latestValue = "";
    const view = render(
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
      expect(latestValue).toBe(TRIGGER_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("Webhook.occurredAt");
    });
  });

  it("renders a pill immediately after mouse selection in TemplateBadgeTextarea", async () => {
    let latestValue = "";
    const view = render(
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
      expect(latestValue).toBe(TRIGGER_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("Webhook.occurredAt");
    });

    expect(document.activeElement).toBe(textbox);
  });

  it("puts the number first for a duration field and keeps the rest", async () => {
    // A duration field admitted numbers alone, so a payload of strings and
    // timestamps rendered nothing at all. Every field is offered now, ordered by
    // what the target parses: the number, then text, then the instant a duration
    // has no use for.
    const view = render(<DurationTemplateBadgeInput />);
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => {
      expect(menuRows()).toEqual([
        "Webhook.amountCentsAmount in cents",
        "Webhook.patientNamePatient name",
        "Webhook.occurredAtWhen it happened",
      ]);
    });
  });

  it("puts the timestamp first for a date field, the epoch level with the text", async () => {
    // A unix epoch is one of the two forms `parseTimestampWithTimezone` reads, so
    // the number sits with the string rather than below it, and declaration order
    // then decides between them.
    const view = render(
      <ControlledTemplateBadgeInput onValueChange={() => {}} />
    );
    typeAtSymbol(view.getByRole("textbox"));

    await waitFor(() => {
      expect(menuRows()).toEqual([
        "Webhook.occurredAtWhen it happened",
        "Webhook.patientNamePatient name",
        "Webhook.amountCentsAmount in cents",
      ]);
    });
  });

  it("uses currentNodeId for autocomplete when no node is selected in the canvas", async () => {
    surface.actions = [SEND_MESSAGE_ACTION];
    const store = getDefaultStore();
    const nodes: WorkflowNode[] = [
      {
        id: "trigger_1",
        position: { x: 0, y: 0 },
        data: {
          label: "Webhook",
          type: "trigger",
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
      { id: "edge_1", source: "trigger_1", target: "action_1" },
      { id: "edge_2", source: "action_1", target: "condition_1" },
    ];

    store.set(loadWorkflowGraphAtom, { nodes, edges });

    let latestValue = "";
    const view = render(
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
});

describe("Template badge rendering", () => {
  beforeEach(() => {
    seedTemplateContext();
  });

  it("relabels a badge when its node is renamed", async () => {
    // A badge shows the node's current label, but the value it stands for is a
    // token holding the label the token was written against. Renaming a node
    // produces no DOM event, so this is the one thing the editor genuinely has
    // to re-render in response to a React state change.
    const view = render(
      <UncontrolledTemplateBadgeInput value={TRIGGER_TEMPLATE} />
    );

    const textbox = view.getByRole("textbox");
    await waitFor(() => {
      expect(textbox.querySelector("[data-template]")?.textContent).toBe(
        "Webhook.occurredAt"
      );
    });

    getDefaultStore().set(updateNodeDataAtom, {
      id: "trigger_1",
      data: { label: "Incoming Hook" },
    });

    await waitFor(() => {
      expect(textbox.querySelector("[data-template]")?.textContent).toBe(
        "Incoming Hook.occurredAt"
      );
    });
  });

  it("renders a value the parent supplies while the field is not focused", async () => {
    const view = render(<UncontrolledTemplateBadgeInput value="" />);
    const textbox = view.getByRole("textbox");

    view.rerender(<UncontrolledTemplateBadgeInput value={TRIGGER_TEMPLATE} />);

    await waitFor(() => {
      expect(textbox.querySelector("[data-template]")?.textContent).toBe(
        "Webhook.occurredAt"
      );
    });
  });

  it("reads a badge back as the raw token it stands for", async () => {
    let latestValue = "";
    const view = render(
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

    await waitFor(() => expect(latestValue).toBe(TRIGGER_TEMPLATE));

    // Typing after the badge appends to the token, rather than replacing the
    // badge with the label the user can see.
    textbox.append(document.createTextNode(" done"));
    fireEvent.input(textbox);

    await waitFor(() => {
      expect(latestValue).toBe(`${TRIGGER_TEMPLATE} done`);
    });
  });
});

describe("Template badge editing", () => {
  beforeEach(() => {
    seedTemplateContext();
  });

  it("does not read its own placeholder back as the value", async () => {
    // An empty unfocused field shows prompt text, which lives in the same
    // contentEditable as anything the user types.
    let latestValue = "";
    const view = render(
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
    const view = render(
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

    getDefaultStore().set(updateNodeDataAtom, {
      id: "trigger_1",
      data: { label: "Renamed" },
    });

    await waitFor(() => expect(textbox.textContent).toBe("abc"));
    expect(latestValue).toBe("abc");
  });
});
