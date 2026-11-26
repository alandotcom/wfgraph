import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import {
  execution,
  installRunsRevealRpc,
  labelledGraph,
  log,
  removeRunsRevealRpc,
  renderRunsReveal,
  runHeading,
  served,
} from "#src/components/workflow/canvas-reveal/runs-reveal.test-support";

beforeEach(() => {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width: 1440 });
  installRunsRevealRpc();
});
afterEach(removeRunsRevealRpc);

/** Two steps in a row, as one run's pinned graph. */
function twoSteps() {
  return labelledGraph(
    [
      { id: "confirm", label: "Send confirmation" },
      { id: "receipt", label: "Send receipt" },
    ],
    undefined,
    [["confirm", "receipt"]]
  );
}

describe("RunsColumn", () => {
  it("lists the runs in the outline and leaves the Inspector pointing at it", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { view, aside, rows, router, title, show } = await renderRunsReveal({
      view: "runs",
    });
    // Runs opens on the list; the route names no run.
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });

    // A run opened and left with Back returns to the same list.
    await show({ view: "runs", executionId: "exec_b" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_b")));
    fireEvent.click(view.getByRole("button", { name: "Back to runs" }));
    await waitFor(() => expect(rows()).toHaveLength(2));

    const column = view.getByTestId("outline-column");
    expect(
      within(column).getAllByTestId("workflow-run-summary-row")
    ).toHaveLength(2);
    expect(aside()?.textContent).toContain(
      "Open a run from the list to see its summary here."
    );
  });

  it("opens a completed run with nothing selected", async () => {
    served.items = [execution("exec_s", "completed")];
    served.graphs = { ver_exec_s: twoSteps() };
    served.logsByExecutionId = {
      exec_s: [
        log({
          id: "log_confirm",
          nodeId: "confirm",
          nodeName: "Send confirmation",
          status: "success",
        }),
      ],
    };
    const { view, store, aside, title } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_s",
    });

    await waitFor(() => expect(title()).toBe(runHeading("exec_s")));
    await view.findAllByRole("treeitem");
    expect(store.get(activeSelectionAtom).nodeIds).toEqual([]);
    expect(aside()?.dataset.level).toBe("browse");
  });

  it("opens the next and previous run with J and K", async () => {
    served.items = [
      execution("exec_c", "completed"),
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { router, title } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_b",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_b")));

    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        executionId: "exec_a",
      })
    );
    await waitFor(() => expect(title()).toBe(runHeading("exec_a")));
    fireEvent.keyDown(document.body, { key: "k" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_b")));
    fireEvent.keyDown(document.body, { key: "k" });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        executionId: "exec_c",
      })
    );
  });

  it("says which version a published run's step numbers belong to, and says nothing for a draft run", async () => {
    served.items = [
      {
        ...execution("exec_v", "completed"),
        versionKind: "published",
        versionNumber: 2,
      },
      {
        ...execution("exec_d", "completed"),
        versionKind: "draft_snapshot",
        versionNumber: null,
      },
    ];
    const { view, title, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_v",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_v")));
    const column = view.getByTestId("outline-column");
    await waitFor(() =>
      expect(
        within(column).getByText(
          "Steps as of v2, so a number can differ from the draft."
        )
      ).toBeTruthy()
    );

    await show({ view: "runs", executionId: "exec_d" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_d")));
    expect(column.querySelector('[data-slot="run-steps-version"]')).toBeNull();
  });
});
