import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeDescription } from "#src/components/flow-elements/node";

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0];

let resizeCallbacks: ResizeObserverCallback[] = [];
let observedElements: Element[] = [];
let descriptionDimensions = { clientWidth: 0, scrollWidth: 0 };

class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }

  disconnect() {}

  observe(element: Element) {
    observedElements.push(element);
  }

  unobserve() {}
}

function setDescriptionDimensions(input: {
  clientWidth: number;
  scrollWidth: number;
}): void {
  descriptionDimensions = input;
}

async function reportResize(): Promise<void> {
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    await Promise.resolve();
  });
}

function descriptionTrigger(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector(".workflow-node-description");
  if (!trigger) {
    throw new Error("missing description line");
  }
  return trigger as HTMLElement;
}

afterEach(() => {
  resizeCallbacks = [];
  observedElements = [];
  descriptionDimensions = { clientWidth: 0, scrollWidth: 0 };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NodeDescription", () => {
  it("leaves an empty description out of keyboard navigation", () => {
    const { container } = render(<NodeDescription>{""}</NodeDescription>);

    expect(descriptionTrigger(container).getAttribute("tabindex")).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("adds the tooltip trigger only after a description overflows", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => descriptionDimensions.clientWidth
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => descriptionDimensions.scrollWidth
    );
    setDescriptionDimensions({ clientWidth: 160, scrollWidth: 160 });
    const { container, rerender } = render(
      <NodeDescription>Fitting description</NodeDescription>
    );

    const fitting = descriptionTrigger(container);
    expect(resizeCallbacks).toHaveLength(1);
    expect(observedElements).toEqual([fitting]);
    await reportResize();

    expect(fitting.getAttribute("tabindex")).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    const description =
      "Line one\nA long unbroken description: supercalifragilisticexpialidocious";
    setDescriptionDimensions({ clientWidth: 160, scrollWidth: 320 });
    rerender(<NodeDescription>{description}</NodeDescription>);
    const clipped = descriptionTrigger(container);

    expect(clipped.classList.contains("nodrag")).toBe(true);
    expect(clipped.classList.contains("nowheel")).toBe(true);
    expect(clipped.dataset.slot).toBe("tooltip-trigger");
    expect(clipped.getAttribute("tabindex")).toBe("0");

    fireEvent.focus(clipped);

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      description
    );
  });

  it("removes the tooltip trigger when a wider container fits the description", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => descriptionDimensions.clientWidth
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => descriptionDimensions.scrollWidth
    );
    setDescriptionDimensions({ clientWidth: 100, scrollWidth: 240 });
    const { container } = render(
      <NodeDescription>Wide but initially clipped description</NodeDescription>
    );

    const description = descriptionTrigger(container);
    expect(description.getAttribute("tabindex")).toBe("0");

    setDescriptionDimensions({ clientWidth: 320, scrollWidth: 240 });
    await reportResize();
    expect(descriptionTrigger(container).getAttribute("tabindex")).toBeNull();
  });

  it("keeps a touch click on a clipped description in the node selection path", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => descriptionDimensions.clientWidth
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => descriptionDimensions.scrollWidth
    );
    setDescriptionDimensions({ clientWidth: 100, scrollWidth: 240 });
    const onNodeClick = vi.fn();
    const { container } = render(
      <div onClick={onNodeClick}>
        <NodeDescription>Clipped description</NodeDescription>
      </div>
    );

    const description = descriptionTrigger(container);
    fireEvent.pointerDown(description, { pointerType: "touch" });
    fireEvent.click(description);

    expect(onNodeClick).toHaveBeenCalledOnce();
  });
});
