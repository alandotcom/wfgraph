import { beforeEach, describe, expect, it } from "bun:test";
import { getDefaultStore } from "jotai";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { edgesAtom, nodesAtom } from "@/client/lib/workflow-store";
import type { WorkflowEdge, WorkflowNode } from "@/shared/workflow/types";
import { TemplateBadgeInput } from "./template-badge-input";
import { TemplateBadgeTextarea } from "./template-badge-textarea";

const TRIGGER_TEMPLATE = "{{@trigger_1:Webhook.timestamp}}";
const HTTP_STATUS_TEMPLATE = "{{@http_1:HTTP Request.status}}";

function seedTemplateContext(selectedNodeId = "wait_1") {
  const store = getDefaultStore();
  const nodes: WorkflowNode[] = [
    {
      id: "trigger_1",
      position: { x: 0, y: 0 },
      data: {
        label: "Webhook",
        type: "trigger",
        config: { triggerType: "Webhook" },
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
    { id: "edge_1", source: "trigger_1", target: "wait_1" },
  ];

  store.set(nodesAtom, nodes);
  store.set(edgesAtom, edges);
}

function findTimestampOption(): HTMLElement {
  const option = document.body.querySelector(".cursor-pointer");

  if (!(option instanceof HTMLElement)) {
    throw new Error("Failed to find autocomplete option");
  }

  return option;
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
      expect(badge?.textContent).toBe("Webhook.timestamp");
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
      expect(badge?.textContent).toBe("Webhook.timestamp");
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
      expect(badge?.textContent).toBe("Webhook.timestamp");
    });

    expect(document.activeElement).toBe(textbox);
  });

  it("uses currentNodeId for autocomplete when no node is selected in the canvas", async () => {
    const store = getDefaultStore();
    const nodes: WorkflowNode[] = [
      {
        id: "trigger_1",
        position: { x: 0, y: 0 },
        data: {
          label: "Webhook",
          type: "trigger",
          config: { triggerType: "Webhook" },
        },
      },
      {
        id: "http_1",
        position: { x: 240, y: 0 },
        data: {
          label: "HTTP Request",
          type: "action",
          config: { actionType: "HTTP Request" },
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
      { id: "edge_1", source: "trigger_1", target: "http_1" },
      { id: "edge_2", source: "http_1", target: "condition_1" },
    ];

    store.set(nodesAtom, nodes);
    store.set(edgesAtom, edges);

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
      findAutocompleteOptionByText("HTTP Request.status")
    );
    fireEvent.mouseDown(option);

    await waitFor(() => {
      expect(latestValue).toBe(HTTP_STATUS_TEMPLATE);
      const badge = textbox.querySelector("[data-template]");
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toBe("HTTP Request.status");
    });
  });
});
