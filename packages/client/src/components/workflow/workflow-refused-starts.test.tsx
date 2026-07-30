import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowRefusedStarts } from "#src/components/workflow/workflow-refused-starts";
import type { RefusedStart } from "#src/lib/execution-logs";

function refusal(id: string, message: string): RefusedStart {
  return {
    id,
    message,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
  };
}

describe("WorkflowRefusedStarts", () => {
  // Most workflows refuse nothing, and a heading over an empty list would be a
  // section about nothing on every one of them.
  it("renders nothing when no start was refused", () => {
    const view = render(<WorkflowRefusedStarts refusedStarts={[]} />);

    expect(view.container.textContent).toBe("");
  });

  it("renders the sentence each refusal was recorded with", () => {
    const view = render(
      <WorkflowRefusedStarts
        refusedStarts={[
          refusal("evt_1", "Refused a start from event app/x: first-wins"),
          refusal("evt_2", "Refused a start from event app/y: first-wins"),
        ]}
      />
    );

    expect(view.getByText("Refused Starts")).toBeTruthy();
    expect(
      view.getByText("Refused a start from event app/x: first-wins")
    ).toBeTruthy();
    expect(
      view.getByText("Refused a start from event app/y: first-wins")
    ).toBeTruthy();
  });
});
