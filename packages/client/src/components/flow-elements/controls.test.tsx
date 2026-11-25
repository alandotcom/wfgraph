import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

    fireEvent.click(getByRole("button", { name: "Tidy layout" }));
    expect(onReflow).toHaveBeenCalledTimes(1);
  });

  test("names each control in the app's tooltip, with its shortcut as a keycap", async () => {
    const { getByRole } = render(
      <ReactFlowProvider>
        <Controls onReflow={() => {}} />
      </ReactFlowProvider>
    );

    const fitView = getByRole("button", { name: "Fit view" });
    expect(fitView.hasAttribute("title")).toBe(false);
    fireEvent.pointerEnter(fitView, { pointerType: "mouse" });
    fireEvent.mouseEnter(fitView);
    fireEvent.mouseMove(fitView);
    const tooltip = await waitFor(() => {
      const element = document.querySelector('[data-slot="tooltip-content"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(tooltip.textContent).toContain("Fit view");
    expect(tooltip.querySelector('[data-slot="kbd"]')?.textContent).toMatch(
      /\/$/
    );
  });

  test("disables reflow button when canReflow is false", () => {
    const { getByRole } = render(
      <ReactFlowProvider>
        <Controls canReflow={false} onReflow={() => {}} />
      </ReactFlowProvider>
    );

    // Focusable while disabled, so its tooltip can still say what it is.
    const button = getByRole("button", { name: "Tidy layout" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  test("keeps the zoom buttons at 44px on a phone", () => {
    const { getByRole } = render(
      <ReactFlowProvider>
        <Controls />
      </ReactFlowProvider>
    );

    expect(getByRole("button", { name: "Zoom in" }).className).toContain(
      "size-11"
    );
  });
});
