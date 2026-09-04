import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { Controls } from "./controls";

afterEach(() => {
  cleanup();
});

describe("Controls", () => {
  function SetOverviewZoom() {
    const store = useStoreApi();
    return (
      <button
        onClick={() => store.setState({ transform: [0, 0, 0.5] })}
        type="button"
      >
        Set overview zoom
      </button>
    );
  }

  test("renders and wires reflow action when provided", () => {
    const onReflow = vi.fn(() => {});

    const { getByRole } = render(
      <ReactFlowProvider>
        <Controls onReflow={onReflow} />
      </ReactFlowProvider>
    );

    fireEvent.click(getByRole("button", { name: "Reflow nodes" }));
    expect(onReflow).toHaveBeenCalledTimes(1);
  });

  test("disables reflow button when canReflow is false", () => {
    const { getByRole } = render(
      <ReactFlowProvider>
        <Controls canReflow={false} onReflow={() => {}} />
      </ReactFlowProvider>
    );

    const button = getByRole("button", { name: "Reflow nodes" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("shows a find-node cue in overview and keeps mobile controls at 44px", () => {
    const { getByRole, getByText } = render(
      <ReactFlowProvider>
        <SetOverviewZoom />
        <Controls />
      </ReactFlowProvider>
    );

    expect(getByRole("button", { name: "Zoom in" }).className).toContain(
      "size-11"
    );
    fireEvent.click(getByRole("button", { name: "Set overview zoom" }));

    expect(getByText("Overview")).toBeTruthy();
    expect(
      getByRole("button", { name: "Find a node" }).className
    ).toContain("h-11");
  });
});
