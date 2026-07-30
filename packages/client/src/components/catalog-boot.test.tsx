import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CatalogUnavailable } from "#src/components/catalog-boot";

describe("CatalogUnavailable", () => {
  // The editor used to draw itself from an empty catalog when this fetch failed,
  // and the panels then told the builder their host declared no Events. The
  // failure names the endpoint instead, and offers the one thing worth trying.
  it("names the endpoint and offers a retry", () => {
    const view = render(
      <CatalogUnavailable
        endpoint="/rova/api/extensions"
        reason="unreachable"
      />
    );

    expect(view.getByText(/GET \/rova\/api\/extensions/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says which of the three failures happened", () => {
    const view = render(
      <CatalogUnavailable endpoint="/api/extensions" reason="mismatch" />
    );

    expect(view.getByText(/different builds of Rova/)).toBeTruthy();
    expect(view.queryByText(/did not answer/)).toBeNull();
  });
});
