import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { router } from "#src/router";

const workflowRoute = router.routesById["/workflows/$workflowId"];
const appLoader = workflowRoute.options.loader;

/**
 * Replace the editor route's loader with one that records the workflow each
 * load was for. The loader's declared type is tied to the route's own
 * inference, which a test stand-in cannot name.
 */
function recordLoads(loads: string[]): void {
  Reflect.set(
    workflowRoute.options,
    "loader",
    ({ params }: { params: { workflowId: string } }) => {
      loads.push(params.workflowId);
    }
  );
}

afterEach(() => {
  Reflect.set(workflowRoute.options, "loader", appLoader);
});

describe("editor route loader", () => {
  it("loads each workflow change and skips a search-only change", async () => {
    // The loader hydrates the store from the server, so the case counts which
    // workflow each load was for instead of running it.
    const loads: string[] = [];
    recordLoads(loads);
    const history = createMemoryHistory({
      initialEntries: ["/workflows/workflow_a"],
    });
    const testRouter = createRouter({ routeTree: router.routeTree, history });
    await testRouter.load();

    await testRouter.navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: "workflow_a" },
      search: { group: "group_1" },
    });
    await testRouter.navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: "workflow_b" },
      search: {},
    });
    await testRouter.navigate({
      to: "/workflows/$workflowId",
      params: { workflowId: "workflow_a" },
      search: {},
    });
    expect(loads).toEqual(["workflow_a", "workflow_b", "workflow_a"]);

    // Mounted, `RouterProvider` loads on every history change; unmounted, the
    // case does the same by hand.
    history.back();
    await testRouter.load();
    expect(testRouter.state.location.pathname).toBe("/workflows/workflow_b");
    expect(loads).toEqual([
      "workflow_a",
      "workflow_b",
      "workflow_a",
      "workflow_b",
    ]);
  });
});
