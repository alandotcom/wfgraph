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
  it("lists the runs in the left column and leaves the details column pointing at it", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { view, aside, rows, title } = await renderRunsReveal({
      view: "runs",
    });
    // The first visit opens the newest run, and Back reaches the list.
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

  it("opens a failed run with the step that failed selected and its evidence in details", async () => {
    served.items = [execution("exec_f", "failed")];
    served.graphs = { ver_exec_f: twoSteps() };
    served.logsByExecutionId = {
      exec_f: [
        log({
          id: "log_confirm",
          nodeId: "confirm",
          nodeName: "Send confirmation",
          status: "success",
        }),
        log({
          id: "log_receipt",
          nodeId: "receipt",
          nodeName: "Send receipt",
          status: "error",
          error: "invalid_auth",
          startedAt: "2026-03-01T10:00:05.000Z",
        }),
      ],
    };
    const { view, store, aside, title } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_f",
    });

    await waitFor(() =>
      expect(store.get(activeSelectionAtom).nodeIds).toEqual(["receipt"])
    );
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Send receipt");
    const column = view.getByTestId("outline-column");
    expect(within(column).getByText(runHeading("exec_f"))).toBeTruthy();
    expect(
      within(column)
        .getAllByRole("treeitem")
        .find((row) => row.textContent?.includes("Send receipt"))
        ?.getAttribute("aria-selected")
    ).toBe("true");
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
});
