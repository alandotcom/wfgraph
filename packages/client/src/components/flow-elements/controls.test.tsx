import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { Controls } from "./controls";

afterEach(() => {
  cleanup();
});

describe("Controls", () => {
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
});
