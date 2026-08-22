import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Separator } from "#src/components/ui/separator";

describe("Separator", () => {
  it("is decorative by default", () => {
    const { container } = render(<Separator />);

    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });

  it("can expose a semantic separator", () => {
    const { container } = render(<Separator decorative={false} />);

    expect(container.firstElementChild?.hasAttribute("aria-hidden")).toBe(false);
  });
});
