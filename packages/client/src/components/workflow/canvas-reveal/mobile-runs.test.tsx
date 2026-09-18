import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  rpcErrorResponse,
  answerWorkflowRunRpc,
} from "#src/lib/rpc-fetch-test-support";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  activeMobileSheetsAtom,
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  afterPaint,
  callCount,
  execution,
  installRunsRevealRpc,
  labelledGraph,
  log,
  removeRunsRevealRpc,
  renderRunsReveal,
  runsRpc,
  served,
  waitingRun,
} from "./runs-reveal.test-support";

/** Happy-dom's viewport, which the `md` media query answers from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

beforeEach(() => {
  setViewportWidth(390);
  installRunsRevealRpc();
});
afterEach(() => {
  setViewportWidth(1440);
  removeRunsRevealRpc();
});

/** Two completed runs; the older one reached one step with recorded input. */
function serveTwoRuns() {
  served.items = [
    execution("exec_b", "completed"),
    execution("exec_a", "completed"),
  ];
  served.graphs = {
    ver_exec_a: labelledGraph([{ id: "send", label: "Send reminder" }]),
    ver_exec_b: labelledGraph([{ id: "send", label: "Send reminder" }]),
  };
  served.logsByExecutionId = {
    exec_a: [
      log({
        id: "log_send",
        nodeId: "send",
        nodeName: "Send reminder",
        status: "success",
        input: { to: "patient@example.com" },
      }),
    ],
  };
}

/** The Runs harness below `md`, with the sheet's own reads. */
async function renderMobileRuns(
  search: Parameters<typeof renderRunsReveal>[0]
) {
  const harness = await renderRunsReveal(search);
  const { view, sheet, store } = harness;
  const sheetTitle = () =>
    sheet()?.querySelector('[data-slot="reveal-title"]') ?? null;
  const press = (name: string) =>
    fireEvent.click(view.getByRole("button", { name }));
  const levels = () =>
    store
      .get(activeMobileSheetsAtom)
      .map((item) => `${item.level}:${item.inspected?.id ?? "address"}`);
  /** The one scroller the sheet shows, or null. */
  const scroller = () =>
    [
      ...(sheet()?.querySelectorAll<HTMLElement>(".overflow-y-auto") ?? []),
    ].find((element) => element.closest("[hidden]") === null) ?? null;
  const scrollTo = (top: number) => {
    const body = scroller();
    if (!body) {
      throw new Error("no sheet scroller is on screen");
    }
    body.scrollTop = top;
    fireEvent.scroll(body);
    fireEvent(body, new Event("scrollend"));
  };
  const canvasCovered = () =>
    view.getByTestId("workflow-canvas").closest("[inert]") !== null;
  return {
    ...harness,
    sheetTitle,
    press,
    levels,
    scroller,
    scrollTo,
    canvasCovered,
  };
}

describe("mobile Runs sequence", () => {
  it("goes from the run list to a run's summary and journey to node evidence, one sheet at a time", async () => {
    serveTwoRuns();
    const {
      view,
      store,
      router,
      aside,
      sheet,
      sheetTitle,
      rows,
      press,
      levels,
      canvasCovered,
      evidence,
    } = await renderMobileRuns({});

    press("Show Runs");
    // The first visit opens the newest run in the run's own sheet.
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #2"));
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_b",
    });
    expect(aside()).toBeNull();
    expect(
      view.getByRole("region", { name: "Runs inspector" }).dataset.level
    ).toBe("summary");

    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(sheetTitle()?.textContent).toBe("Runs");
    expect(view.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]));

    fireEvent.click(rows()[1]);
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_a",
    });
    await waitFor(() => expect(document.activeElement).toBe(sheetTitle()));

    const entry = await view.findByRole("button", {
      name: "Send reminder, Success",
    });
    fireEvent.click(entry);
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));
    expect(levels()).toEqual(["summary:address", "inspector:send"]);
    expect(sheetTitle()?.textContent).toBe("Send reminder");
    expect(within(evidence()).getByText(/patient@example.com/)).toBeTruthy();
    // One pane at a time: the journey is hidden behind the evidence.
    expect(
      view.queryByRole("button", { name: "Send reminder, Success" })
    ).toBeNull();
    expect(canvasCovered()).toBe(true);
    expect(store.get(selectedNodeAtom)).toBe("send");

    press("Back to Run #1");
    await waitFor(() => expect(sheet()?.dataset.level).toBe("summary"));
    expect(canvasCovered()).toBe(false);
    expect(sheetTitle()?.textContent).toBe("Run #1");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Send reminder, Success" })
      )
    );

    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));

    press("Close");
    expect(sheet()).toBeNull();
    expect(router.state.location.search).toEqual({ view: "runs" });
  });

  it("opens evidence from a canvas node and restores the run's scroll and selection on Back, leaving the camera", async () => {
    serveTwoRuns();
    const {
      store,
      sheet,
      sheetTitle,
      press,
      levels,
      scroller,
      scrollTo,
      canvasNode,
    } = await renderMobileRuns({ view: "runs", executionId: "exec_a" });

    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    scrollTo(80);
    const camera = { centerX: 12, centerY: 34, zoom: 0.75 };
    act(() => {
      store.set(recordWorkspaceCameraAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        formFactor: "mobile",
        camera,
      });
    });

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));
    expect(levels()).toEqual(["summary:address", "inspector:send"]);

    press("Back to Run #1");
    await waitFor(() => expect(sheet()?.dataset.level).toBe("summary"));
    expect(store.get(activeWorkspaceCamerasAtom).mobile).toEqual(camera);
    expect(store.get(selectedNodeAtom)).toBe("send");
    await afterPaint();
    expect(scroller()?.scrollTop).toBe(80);
    // With the node still selected, the run's sheet offers its evidence again.
    expect(sheetTitle()?.textContent).toBe("Run #1");
    press("Show evidence");
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));
  });

  it("returns focus to the canvas node when Back leaves evidence a canvas press opened", async () => {
    serveTwoRuns();
    const { sheet, sheetTitle, press, canvasNode } = await renderMobileRuns({
      view: "runs",
      executionId: "exec_a",
    });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    const node = await canvasNode("Send reminder");
    fireEvent.click(node);
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));

    press("Back to Run #1");
    await waitFor(() => expect(sheet()?.dataset.level).toBe("summary"));
    await afterPaint();
    expect(document.activeElement).toBe(node);
  });

  it("keeps the sequence when a run starts from an open run's sheet", async () => {
    serveTwoRuns();
    const { router, sheet, sheetTitle, press, levels } = await renderMobileRuns(
      { view: "runs", executionId: "exec_a" }
    );
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));

    // Starting a run replaces the route with the run list, then opens the new
    // run, as `useWorkflowHandlers` navigates.
    served.items = [execution("exec_c", "running"), ...served.items];
    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "runs" },
        replace: true,
      });
    });
    expect(levels()).toEqual(["summary:address"]);
    await act(async () => {
      await router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_1" },
        search: { view: "runs", executionId: "exec_c" },
      });
    });
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #3"));
    expect(levels()).toEqual(["summary:address"]);
    expect(sheet()?.dataset.level).toBe("summary");
  });

  it("restores the run list scroll when Back leaves a run", async () => {
    serveTwoRuns();
    const { sheetTitle, rows, press, scroller, scrollTo } =
      await renderMobileRuns({ view: "runs" });
    press("Configuration");
    // The first visit opens the newest run; Back reaches the list.
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #2"));
    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(2));
    scrollTo(40);

    fireEvent.click(rows()[1]);
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await afterPaint();
    expect(scroller()?.scrollTop).toBe(40);
  });

  it("unwinds the same way on Escape as on Back", async () => {
    serveTwoRuns();
    const { router, sheet, sheetTitle, rows, press, escape, canvasNode } =
      await renderMobileRuns({ view: "runs", executionId: "exec_a" });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));

    act(() => escape());
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    act(() => escape());
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });
    act(() => escape());
    expect(sheet()).toBeNull();
  });

  it("restores the open run and the evidence depth after a visit to Draft", async () => {
    serveTwoRuns();
    const { router, sheet, sheetTitle, press, levels, canvasNode, evidence } =
      await renderMobileRuns({ view: "runs", executionId: "exec_a" });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));

    press("Back to Run #1");
    await waitFor(() => expect(sheet()?.dataset.level).toBe("summary"));
    press("Show evidence");
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));

    // The switcher sits outside the covered canvas, as the toolbar does.
    press("Show Draft");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(sheet()).toBeNull();

    press("Show Runs");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        view: "runs",
        executionId: "exec_a",
      })
    );
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));
    expect(levels()).toEqual(["summary:address", "inspector:send"]);
    expect(within(evidence()).getByText(/patient@example.com/)).toBeTruthy();
    press("Back to Run #1");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
  });
});

describe("mobile Runs under polling and late responses", () => {
  it("keeps the evidence sheet, selection and run while polls land", async () => {
    served.items = [execution("exec_r", "running")];
    served.graphs = {
      ver_exec_r: labelledGraph([
        { id: "send", label: "Send reminder" },
        { id: "notify", label: "Notify staff" },
      ]),
    };
    served.logsByExecutionId = {
      exec_r: [
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
        }),
      ],
    };
    const {
      store,
      router,
      queryClient,
      sheet,
      sheetTitle,
      press,
      levels,
      canvasNode,
    } = await renderMobileRuns({ view: "runs", executionId: "exec_r" });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));

    served.logsByExecutionId = {
      exec_r: [
        ...served.logsByExecutionId.exec_r,
        log({
          id: "log_notify",
          nodeId: "notify",
          nodeName: "Notify staff",
          status: "running",
          startedAt: "2026-03-01T10:00:02.000Z",
        }),
      ],
    };
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await afterPaint();

    expect(levels()).toEqual(["summary:address", "inspector:send"]);
    expect(sheetTitle()?.textContent).toBe("Send reminder");
    expect(store.get(selectedNodeAtom)).toBe("send");
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_r",
    });
  });

  it("never lets a late response for an earlier run replace the run on screen", async () => {
    serveTwoRuns();
    let releaseEarlier: (() => void) | null = null;
    runsRpc.override = (path, input) =>
      path === "workflow/getExecutionLogs" && input.executionId === "exec_a"
        ? new Promise<Response>((resolve) => {
            releaseEarlier = () =>
              void answerWorkflowRunRpc(served, path, input).then(resolve);
          })
        : undefined;
    const { sheetTitle, rows, press, show } = await renderMobileRuns({
      view: "runs",
      executionId: "exec_a",
    });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #2"));

    await act(async () => {
      releaseEarlier?.();
    });
    await afterPaint();
    expect(sheetTitle()?.textContent).toBe("Run #2");
    await show({ view: "runs", executionId: "exec_a" });
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
  });
});

describe("mobile Runs states", () => {
  it("keeps Resume and Cancel usable on a waiting run", async () => {
    served.items = [execution("exec_w", "waiting")];
    served.logsByExecutionId = {
      exec_w: [
        log({
          id: "log_w",
          nodeId: "w",
          nodeName: "Wait in exec_w",
          status: "running",
        }),
      ],
    };
    served.waitsByExecutionId = { exec_w: waitingRun("exec_w", "tok_w") };
    const { view, sheetTitle, press } = await renderMobileRuns({
      view: "runs",
      executionId: "exec_w",
    });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    expect(
      await view.findByRole("heading", { name: "Waiting at Wait in exec_w" })
    ).toBeTruthy();

    press("Resume now");
    await waitFor(() => expect(callCount("workflow/resumeWait")).toBe(1));
    press("Cancel");
    await waitFor(() => expect(callCount("workflow/cancelExecution")).toBe(1));
  });

  it("shows a failed run's failure, an exited run's exit details, and superseded runs and refused starts in the list", async () => {
    served.items = [
      execution("exec_x", "exited"),
      execution("exec_f", "failed"),
      execution("exec_s", "superseded"),
    ];
    served.supersededCount = 1;
    served.refusedStarts = [
      {
        id: "evt_start_1",
        message: "Start Filter declined the event",
        createdAt: "2026-03-01T09:59:00.000Z",
      },
    ];
    served.logsByExecutionId = {
      exec_f: [
        log({
          id: "log_f",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "error",
          error: "SMTP refused the message",
        }),
      ],
    };
    served.exitByExecutionId = {
      exec_x: {
        reason: "entity_not_found",
        entityType: "appointment",
        nodeId: "send",
        checkedAt: "2026-03-01T10:00:05.000Z",
      },
    };
    const { view, sheetTitle, rows, press } = await renderMobileRuns({
      view: "runs",
      executionId: "exec_f",
    });
    press("Configuration");
    expect(
      await view.findByRole("heading", { name: "Failed at Send reminder" })
    ).toBeTruthy();
    expect(sheetTitle()?.nextElementSibling?.textContent).toBe("Failed");

    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(rows()[0]);
    expect(
      await view.findByRole("heading", { name: "Exit details" })
    ).toBeTruthy();

    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(view.getByText("Refused Starts")).toBeTruthy();
    expect(
      view.getByText("1 run was superseded by a newer start")
    ).toBeTruthy();
    press("Show");
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it("offers Retry and Back on a run that could not be loaded", async () => {
    served.items = [execution("exec_ok", "completed")];
    runsRpc.override = (path, input) =>
      path === "workflow/getExecutionLogs" && input.executionId === "exec_gone"
        ? Promise.resolve(
            rpcErrorResponse({
              code: "INTERNAL_SERVER_ERROR",
              status: 500,
              message: "The run could not be read",
            })
          )
        : undefined;
    const { view, sheetTitle, rows, press } = await renderMobileRuns({
      view: "runs",
      executionId: "exec_gone",
    });
    press("Configuration");
    expect(await view.findByText("This run could not be loaded.")).toBeTruthy();
    expect(sheetTitle()?.textContent).toBe("Run unavailable");
    const before = callCount("workflow/getExecutionLogs");
    press("Retry");
    await waitFor(() =>
      expect(callCount("workflow/getExecutionLogs")).toBeGreaterThan(before)
    );

    press("Back to Runs");
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it("opens a Group card's run summary in the run's sheet", async () => {
    served.items = [execution("exec_g", "completed")];
    served.graphs = {
      ver_exec_g: labelledGraph(
        [
          { id: "lookup", label: "Look up patient" },
          { id: "send", label: "Send reminder" },
        ],
        { id: "grp", label: "Outreach", members: ["lookup", "send"] },
        [["lookup", "send"]]
      ),
    };
    const { view, sheet, sheetTitle, press, levels, canvasNode } =
      await renderMobileRuns({ view: "runs", executionId: "exec_g" });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));

    fireEvent.click(await canvasNode("Outreach"));
    expect(await view.findByTestId("runs-group-summary")).toBeTruthy();
    expect(sheet()?.dataset.level).toBe("summary");
    expect(levels()).toEqual(["summary:address"]);
    expect(sheetTitle()?.textContent).toBe("Outreach");

    press("Back to Run #1");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    expect(view.queryByTestId("runs-group-summary")).toBeNull();
  });
});

describe("mobile Runs accessibility", () => {
  it("names each sheet, keeps controls 44px, and offers no topology authoring", async () => {
    serveTwoRuns();
    const { view, sheet, sheetTitle, press, canvasNode } =
      await renderMobileRuns({ view: "runs", executionId: "exec_a" });
    press("Configuration");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Run #1"));
    const region = () => view.getByRole("region", { name: "Runs inspector" });
    expect(region().classList.contains("mobile-reveal")).toBe(true);
    expect(sheetTitle()?.tagName).toBe("H2");

    const topology = /Delete|Duplicate|Group steps|Ungroup|Add step|Tidy/;
    expect(
      within(region()).queryAllByRole("button", { name: topology })
    ).toEqual([]);
    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(sheet()?.dataset.level).toBe("inspector"));
    expect(
      within(region()).queryAllByRole("button", { name: topology })
    ).toEqual([]);
    const back = view.getByRole("button", { name: "Back to Run #1" });
    expect(back.className).toContain("h-11");
    press("Back to Run #1");
    press("Back to Runs");
    await waitFor(() => expect(sheetTitle()?.textContent).toBe("Runs"));
    expect(
      within(region()).queryAllByRole("button", { name: topology })
    ).toEqual([]);
  });
});
