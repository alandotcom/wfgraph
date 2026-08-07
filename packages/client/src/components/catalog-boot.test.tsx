import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CatalogUnavailable } from "#src/components/catalog-boot";

describe("CatalogUnavailable", () => {
  // A failed catalog fetch names the endpoint that failed rather than drawing
  // the editor from an empty catalog, which would tell the builder their host
  // declared no Events. It offers the one thing worth trying: a retry.
  it("names the endpoint and offers a retry", () => {
    const view = render(
      <CatalogUnavailable
        endpoint="/wfgraph/api/extensions"
        reason="unreachable"
      />
    );

    expect(view.getByText(/GET \/wfgraph\/api\/extensions/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says which of the three failures happened", () => {
    const view = render(
      <CatalogUnavailable endpoint="/api/extensions" reason="mismatch" />
    );

    expect(view.getByText(/different builds of WfGraph/)).toBeTruthy();
    expect(view.queryByText(/did not answer/)).toBeNull();
  });
});
