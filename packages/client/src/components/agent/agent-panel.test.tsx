import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPanel } from "#src/components/agent/agent-panel";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import {
  installAuthorizationGrantsForTests,
  resetAuthorizationGrantsForTests,
} from "#src/lib/authorization-test-support";
import { WfGraphOperationIds } from "@wfgraph/shared/authorization/operations";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

beforeEach(() => {
  installAuthorizationGrantsForTests(WfGraphOperationIds);
});

afterEach(() => {
  resetAuthorizationGrantsForTests();
});

function renderOpenPanel() {
  const store = createStore();
  render(
    <JotaiProvider store={store}>
      <ExtensionCatalogProvider value={emptyExtensionCatalog}>
        <AgentPanel workflowId="workflow_1" />
      </ExtensionCatalogProvider>
    </JotaiProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Agent" }));
  return {
    card: () => screen.getByRole("region", { name: "Build agent" }),
    grip: () => screen.getByRole("button", { name: "Resize the agent panel" }),
  };
}

describe("AgentPanel resize grip", () => {
  it("stops resizing when the browser cancels the drag", () => {
    const { card, grip } = renderOpenPanel();
    const before = card().style.width;

    fireEvent.pointerDown(grip(), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerCancel(grip(), { pointerId: 1 });
    fireEvent.pointerMove(grip(), { pointerId: 1, clientX: 220, clientY: 100 });

    expect(card().style.width).toBe(before);
  });

  it("stops resizing when the grip loses its pointer capture", () => {
    const { card, grip } = renderOpenPanel();
    const before = card().style.width;

    fireEvent.pointerDown(grip(), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent(
      grip(),
      new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 })
    );
    fireEvent.pointerMove(grip(), { pointerId: 1, clientX: 220, clientY: 100 });

    expect(card().style.width).toBe(before);
  });
});
