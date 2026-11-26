import { afterEach, describe, expect, it } from "vitest";
import { outlineRowElementId } from "#src/components/workflow/outline/workflow-outline";
import { focusStepRowOrCard } from "./step-focus-landing";

/** An outline row for `nodeId` inside a floating outline, and its card. */
function mountRowAndCard(nodeId: string, options: { outlineHidden: boolean }) {
  document.body.innerHTML = `
    <section data-slot="floating-outline" ${options.outlineHidden ? "hidden inert" : ""}>
      <div id="${outlineRowElementId(nodeId)}" role="treeitem" tabindex="-1"></div>
    </section>
    <div class="react-flow__node" data-id="${nodeId}" tabindex="0"></div>
  `;
  return {
    row: document.getElementById(outlineRowElementId(nodeId)),
    card: document.querySelector<HTMLElement>(".react-flow__node"),
  };
}

describe("focusStepRowOrCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the step's outline row while the outline shows", () => {
    const { row } = mountRowAndCard("send", { outlineHidden: false });

    expect(focusStepRowOrCard("send")).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("focuses the step's card while `[` has hidden the outline", () => {
    const { card } = mountRowAndCard("send", { outlineHidden: true });

    expect(focusStepRowOrCard("send")).toBe(true);
    expect(document.activeElement).toBe(card);
  });
});
