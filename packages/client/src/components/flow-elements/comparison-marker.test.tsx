import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComparisonMarker } from "#src/components/flow-elements/comparison-marker";

describe("ComparisonMarker", () => {
  it("keeps the visual letter out of the accessibility tree", () => {
    const view = render(<ComparisonMarker comparison={{ kind: "added" }} />);

    expect(view.getByTitle("Added in comparison").getAttribute("aria-hidden")).toBe(
      "true"
    );
    expect(view.queryByRole("img")).toBeNull();
  });
});
