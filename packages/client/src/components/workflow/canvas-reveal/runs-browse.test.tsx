import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAuthorizationGrantsForTests } from "#src/lib/authorization-test-support";
import {
  answerWorkflowRunRpc,
  rpcErrorResponse,
  rpcJsonResponse,
} from "#src/lib/rpc-fetch-test-support";
import { orpcQuery } from "#src/lib/rpc-query";
import {
  executionOverlayGraphAtom,
  selectedNodeAtom,
  selectOnlyNodeAtom,
} from "#src/lib/workflow-graph-store";
import {
  activeWorkspaceAddressAtom,
  activeWorkspaceCamerasAtom,
  recordWorkspaceCameraAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import {
  afterPaint,
  callCount,
  execution,
  installRunsRevealRpc,
  log,
  observerOptions,
  pinnedGraph,
  removeRunsRevealRpc,
  renderRunsReveal,
  runsRpc,
  served,
  waitingRun,
} from "./runs-reveal.test-support";

beforeEach(() => {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width: 1440 });
  installRunsRevealRpc();
});
afterEach(removeRunsRevealRpc);

describe("Runs Browse run list and selected run", () => {
  it("opens the newest run by replacing the entry, and names it in the header", async () => {
    served.items = [
      execution("exec_b", "completed", "appt_2"),
      execution("exec_a", "running"),
    ];
    const { view, router, aside, title, path } = await renderRunsReveal({
      view: "runs",
    });

    await waitFor(() => expect(title()).toBe("Run #2"));
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_b",
    });
    expect(router.history.canGoBack()).toBe(false);
    expect(aside()?.getAttribute("aria-label")).toBe("Runs inspector");
    expect(path()).toBe("Appointment reminders › Runs › Run #2");
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Completed"
    );
    expect(view.getByRole("heading", { name: "app/appointment.created" }));
    expect(view.getByRole("status").textContent).toBe("Completed in 30.00s");
    expect(view.getByText("appt_2")).toBeTruthy();
    expect(view.getByText("Started")).toBeTruthy();
  });

  it("presents the run list, pushes a selected run, and returns focus to its row on Back", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "running"),
    ];
    const { view, router, title, path, rows, back } = await renderRunsReveal({
      view: "runs",
    });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(title()).toBe("Runs");
    expect(path()).toBe("Appointment reminders › Runs");
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();

    fireEvent.click(rows()[1]);
    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_a",
    });
    expect(router.history.canGoBack()).toBe(true);

    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
  });

  it("projects each run's pinned graph and restores that run's selection", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    served.graphs = {
      ver_exec_a: pinnedGraph("a_step"),
      ver_exec_b: pinnedGraph("b_step"),
    };
    const { store, title, rows, back, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });
    const overlayIds = () =>
      store.get(executionOverlayGraphAtom)?.nodes.map((node) => node.id);

    await waitFor(() => expect(overlayIds()).toEqual(["a_step"]));
    await act(async () => {
      store.set(selectOnlyNodeAtom, "a_step");
    });

    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(overlayIds()).toEqual(["b_step"]));
    expect(title()).toBe("Run #2");
    expect(store.get(selectedNodeAtom)).toBeNull();

    await show({ view: "runs", executionId: "exec_a" });
    await waitFor(() => expect(overlayIds()).toEqual(["a_step"]));
    expect(title()).toBe("Run #1");
    expect(store.get(selectedNodeAtom)).toBe("a_step");
  });
  it("leaves an open run for its row the same way on Escape and on Back, and closes from the list", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { view, router, aside, title, rows, show, back, escape } =
      await renderRunsReveal({ view: "runs", executionId: "exec_a" });
    await waitFor(() => expect(title()).toBe("Run #1"));

    escape();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));

    await show({ view: "runs", executionId: "exec_a" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(router.state.location.search).toEqual({ view: "runs" });
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    expect(aside()?.dataset.level).toBe("browse");

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("closed"));
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("puts focus on the Reveal title when the run left behind has no row", async () => {
    served.items = [
      execution("exec_live", "completed"),
      execution("exec_old", "superseded"),
    ];
    served.supersededCount = 1;
    const { aside, title, rows, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_old",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        aside()?.querySelector('[data-slot="reveal-title"]')
      )
    );
    expect(title()).toBe("Runs");
  });

  it("keeps the scroll a focused row set in place of the stored list scroll", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { aside, title, rows, back, listScroller } = await renderRunsReveal({
      view: "runs",
    });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const list = listScroller();
    if (!list) {
      throw new Error("the run list did not render");
    }
    list.scrollTop = 60;
    fireEvent.scroll(list);
    fireEvent(list, new Event("scrollend"));

    fireEvent.click(rows()[1]);
    await waitFor(() => expect(title()).toBe("Run #1"));
    // A browser scrolls a row it focuses into view; happy-dom does not, so a
    // run row taking focus stands in for that scroll here.
    aside()?.addEventListener("focusin", (event) => {
      const scroller = listScroller();
      if (
        event.target instanceof HTMLElement &&
        event.target.dataset.testid === "workflow-run-summary-row" &&
        scroller
      ) {
        scroller.scrollTop = 200;
      }
    });
    back();
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    await afterPaint();
    expect(listScroller()?.scrollTop).toBe(200);
  });
});

describe("Runs Browse selected-run content", () => {
  it("shows active waits, the journey, activity, and Cancel and Resume", async () => {
    served.items = [execution("exec_w", "waiting")];
    served.logsByExecutionId = {
      exec_w: [
        log({
          id: "log_w",
          nodeId: "w",
          nodeName: "Wait for reply",
          status: "running",
        }),
      ],
    };
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_1",
          nodeId: "w",
          nodeName: "Wait for reply",
          resumeToken: "tok_1",
          subscribedEvents: ["app/reply"],
          waitUntil: null,
        },
      ],
    };
    runsRpc.override = (path) =>
      path === "workflow/getExecutionEvents"
        ? Promise.resolve(
            rpcJsonResponse({
              events: [
                {
                  id: "evt_1",
                  eventType: "run_started",
                  message: "Run started",
                  metadata: null,
                  createdAt: "2026-03-01T10:00:00.000Z",
                },
              ],
            })
          )
        : undefined;
    const { view, aside } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_w",
    });

    expect(
      await view.findByRole("heading", { name: "Waiting at Wait for reply" })
    ).toBeTruthy();
    expect(aside()?.querySelector("header")?.textContent).toContain("Waiting");
    expect(view.getByText("Waiting for app/reply")).toBeTruthy();
    expect(view.getByText("Node journey")).toBeTruthy();
    expect(await view.findByText("Activity · 1")).toBeTruthy();
    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Resume now" })).toBeTruthy();
  });

  it("shows the failure summary of a failed run and the exit details of an exited run", async () => {
    served.items = [
      execution("exec_x", "exited"),
      execution("exec_f", "failed"),
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
    const { view, show, aside } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_f",
    });

    expect(
      await view.findByRole("heading", { name: "Failed at Send reminder" })
    ).toBeTruthy();
    expect(
      view.getAllByText("SMTP refused the message").length
    ).toBeGreaterThan(0);
    expect(aside()?.querySelector("header")?.textContent).toContain("Failed");

    await show({ view: "runs", executionId: "exec_x" });
    expect(
      await view.findByRole("heading", { name: "Exit details" })
    ).toBeTruthy();
    expect(view.getByText("Entity not found")).toBeTruthy();
  });

  it("offers no Cancel, Resume, or Clear All without their permissions", async () => {
    installAuthorizationGrantsForTests(
      WfGraphOperationIds.filter(
        (id) =>
          id !== WfGraphOperations.workflowCancelExecution.id &&
          id !== WfGraphOperations.workflowResumeWait.id &&
          id !== WfGraphOperations.workflowDeleteExecutions.id
      )
    );
    served.items = [execution("exec_w", "waiting")];
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_1",
          nodeId: "w",
          nodeName: "Wait for reply",
          resumeToken: "tok_1",
          subscribedEvents: [],
          waitUntil: null,
        },
      ],
    };
    const { view, rows, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_w",
    });

    expect(
      await view.findByRole("heading", { name: "Waiting at Wait for reply" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(view.queryByRole("button", { name: "Resume now" })).toBeNull();

    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Clear All" })).toBeNull();
  });
});

describe("Runs Browse edge cases", () => {
  it("keeps superseded runs, refused starts, and cancellation failures understandable", async () => {
    served.items = [
      execution("exec_live", "completed"),
      execution("exec_old", "superseded"),
    ];
    served.supersededCount = 1;
    served.refusedStarts = [
      {
        id: "refused_1",
        message: "Start Filter declined the event",
        createdAt: "2026-03-01T09:59:00.000Z",
      },
    ];
    served.cancelNotDelivered = [
      {
        id: "cancel_1",
        message: "Cancel Filter declined the event",
        createdAt: "2026-03-01T09:58:00.000Z",
      },
    ];
    const { view, aside, title, rows, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_old",
    });

    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Superseded"
    );
    expect(view.getByRole("status").textContent).toBe(
      "Replaced by a newer start"
    );

    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(
      view.getByText("1 run was superseded by a newer start")
    ).toBeTruthy();
    expect(view.getByText("Start Filter declined the event")).toBeTruthy();
    expect(view.getByText("Cancel Filter declined the event")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("explains a deep link past the list and a run that leaves the list", async () => {
    served.items = [execution("exec_live", "running")];
    const { view, queryClient, title, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_past",
    });

    expect(await view.findByText(/no longer in the runs list/)).toBeTruthy();
    expect(title()).toBe("Run");

    await show({ view: "runs", executionId: "exec_live" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(view.queryByText(/no longer in the runs list/)).toBeNull();

    served.items = [];
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitFor(() =>
      expect(view.getByText(/no longer in the runs list/)).toBeTruthy()
    );
    expect(view.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("shows loading, empty, and retryable failure states", async () => {
    let releaseList: (() => void) | null = null;
    runsRpc.override = (path, input) =>
      path === "workflow/getExecutions" && releaseList === null
        ? new Promise<Response>((resolve) => {
            releaseList = () =>
              resolve(answerWorkflowRunRpc(served, path, input));
          })
        : undefined;
    const { view } = await renderRunsReveal({ view: "runs" });

    expect(await view.findByLabelText("Loading runs")).toBeTruthy();
    await act(async () => {
      releaseList?.();
    });
    expect(await view.findByText("No runs yet")).toBeTruthy();
    expect(view.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("retries a run list that failed to load", async () => {
    let failures = 1;
    runsRpc.override = (path) => {
      if (path === "workflow/getExecutions" && failures > 0) {
        failures -= 1;
        return Promise.resolve(
          rpcErrorResponse({
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "Database unavailable",
          })
        );
      }
      return undefined;
    };
    const { view } = await renderRunsReveal({ view: "runs" });

    expect(await view.findByText("Runs could not be loaded.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("No runs yet")).toBeTruthy();
  });

  it("marks a run that could not be loaded and returns to the list", async () => {
    runsRpc.override = (path) =>
      path === "workflow/getExecutionLogs"
        ? Promise.resolve(
            rpcErrorResponse({
              code: "INTERNAL_SERVER_ERROR",
              status: 500,
              message: "Database unavailable",
            })
          )
        : undefined;
    const { view, router, title, back } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_gone",
    });

    expect(await view.findByText("This run could not be loaded.")).toBeTruthy();
    expect(title()).toBe("Run unavailable");
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();

    back();
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
    expect(await view.findByText("No runs yet")).toBeTruthy();
  });

  it("never lets a late response for an earlier run replace the open run", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    served.logsByExecutionId = {
      exec_a: [
        log({
          id: "log_a",
          nodeId: "a",
          nodeName: "A step",
          status: "success",
        }),
      ],
      exec_b: [
        log({
          id: "log_b",
          nodeId: "b",
          nodeName: "B step",
          status: "success",
        }),
      ],
    };
    served.graphs = {
      ver_exec_a: pinnedGraph("a_step"),
      ver_exec_b: pinnedGraph("b_step"),
    };
    const held: Array<() => void> = [];
    runsRpc.override = (path, input) =>
      input.executionId === "exec_a" &&
      (path === "workflow/getExecutionLogs" ||
        path === "workflow/getExecutionEvents")
        ? new Promise<Response>((resolve) => {
            held.push(() => resolve(answerWorkflowRunRpc(served, path, input)));
          })
        : undefined;
    const { view, store, title, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    await show({ view: "runs", executionId: "exec_b" });
    expect(await view.findByText("B step")).toBeTruthy();
    await act(async () => {
      for (const release of held) {
        release();
      }
    });

    expect(title()).toBe("Run #2");
    expect(view.queryByText("A step")).toBeNull();
    expect(view.getByText("B step")).toBeTruthy();
    await waitFor(() =>
      expect(
        store.get(executionOverlayGraphAtom)?.nodes.map((node) => node.id)
      ).toEqual(["b_step"])
    );
  });
});

describe("Runs Browse reads and writes", () => {
  it("polls the list, and polls logs and events while the run is in progress", async () => {
    served.items = [execution("exec_r", "running")];
    const { view, queryClient } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_r",
    });
    await view.findByRole("button", { name: "Cancel" });

    expect(
      observerOptions(
        queryClient,
        orpcQuery.workflow.getExecutions.queryKey({
          input: { workflowId: "wf_1", includeSuperseded: true },
        })
      ).refetchInterval
    ).toBe(2000);
    const eventsOptions = observerOptions(
      queryClient,
      orpcQuery.workflow.getExecutionEvents.queryKey({
        input: { executionId: "exec_r" },
      })
    );
    expect(eventsOptions.refetchInterval).toBe(2000);
  });

  it("refreshes the run history after Cancel and after Resume", async () => {
    served.items = [execution("exec_w", "waiting")];
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_1",
          nodeId: "w",
          nodeName: "Wait for reply",
          resumeToken: "tok_1",
          subscribedEvents: [],
          waitUntil: null,
        },
      ],
    };
    const { view } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_w",
    });
    const reads = [
      "workflow/getExecutions",
      "workflow/getExecutionLogs",
      "workflow/getExecutionEvents",
    ];
    const counts = () => reads.map(callCount);
    /** Wait until every read has been requested again since `before`. */
    const expectRefreshedSince = async (before: number[]) => {
      await waitFor(() =>
        counts().forEach((count, index) =>
          expect(count).toBeGreaterThan(before[index])
        )
      );
    };

    const resume = await view.findByRole("button", { name: "Resume now" });
    await waitFor(() =>
      expect(counts().every((count) => count > 0)).toBe(true)
    );
    const beforeResume = counts();
    fireEvent.click(resume);
    await waitFor(() => expect(callCount("workflow/resumeWait")).toBe(1));
    await expectRefreshedSince(beforeResume);

    const beforeCancel = counts();
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(callCount("workflow/cancelExecution")).toBe(1));
    await expectRefreshedSince(beforeCancel);
  });
  it("marks only the run whose wait a pending Resume names as resuming", async () => {
    served.items = [
      execution("exec_b", "waiting"),
      execution("exec_a", "waiting"),
    ];
    served.waitsByExecutionId = {
      exec_a: waitingRun("exec_a", "tok_a"),
      exec_b: waitingRun("exec_b", "tok_b"),
    };
    let releaseResume: (() => void) | null = null;
    runsRpc.override = (path, input) =>
      path === "workflow/resumeWait"
        ? new Promise<Response>((resolve) => {
            releaseResume = () =>
              resolve(answerWorkflowRunRpc(served, path, input));
          })
        : undefined;
    const { view, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });

    fireEvent.click(await view.findByRole("button", { name: "Resume now" }));
    await waitFor(() =>
      expect(
        view
          .getByRole("button", { name: "Resume now" })
          .hasAttribute("disabled")
      ).toBe(true)
    );

    await show({ view: "runs", executionId: "exec_b" });
    expect(
      await view.findByRole("heading", { name: "Waiting at Wait in exec_b" })
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Resume now" }).hasAttribute("disabled")
    ).toBe(false);

    await show({ view: "runs", executionId: "exec_a" });
    expect(
      await view.findByRole("heading", { name: "Waiting at Wait in exec_a" })
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Resume now" }).hasAttribute("disabled")
    ).toBe(true);
    await act(async () => {
      releaseResume?.();
    });
  });

  it("reads the open run for the header and the body with one logs request", async () => {
    served.items = [execution("exec_done", "completed")];
    const { title } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_done",
    });

    await waitFor(() => expect(title()).toBe("Run #1"));
    await afterPaint();
    expect(callCount("workflow/getExecutionLogs")).toBe(1);
  });
});

describe("Runs Browse restoration", () => {
  it("restores the run, its overview scroll, and its camera after a visit to Draft", async () => {
    served.items = [execution("exec_a", "completed")];
    const { view, store, aside, title, show } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_a",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));
    const scroller = () =>
      aside()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
    const overview = scroller();
    if (!overview) {
      throw new Error("the run overview did not render");
    }
    overview.scrollTop = 120;
    fireEvent.scroll(overview);
    fireEvent(overview, new Event("scrollend"));
    const camera = { centerX: 40, centerY: 80, zoom: 0.75 };
    await act(async () => {
      store.set(recordWorkspaceCameraAtom, {
        address: store.get(activeWorkspaceAddressAtom),
        formFactor: "desktop",
        camera,
      });
    });

    await show({});
    expect(view.queryByTestId("runs-browse")).toBeNull();
    await show({ view: "runs", executionId: "exec_a" });

    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(aside()?.dataset.level).toBe("browse");
    await waitFor(() => expect(scroller()?.scrollTop).toBe(120));
    expect(store.get(activeWorkspaceCamerasAtom).desktop).toEqual(camera);
  });

  it("restores the run list and its scroll without opening the newest run", async () => {
    served.items = [
      execution("exec_b", "completed"),
      execution("exec_a", "completed"),
    ];
    const { router, aside, title, rows, back, show } = await renderRunsReveal({
      view: "runs",
    });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const scroller = () =>
      aside()?.querySelector<HTMLElement>('[data-slot="runs-list-scroller"]') ??
      null;
    const list = scroller();
    if (!list) {
      throw new Error("the run list did not render");
    }
    list.scrollTop = 60;
    fireEvent.scroll(list);
    fireEvent(list, new Event("scrollend"));

    await show({});
    await show({ view: "runs" });

    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(60));
    expect(router.state.location.search).toEqual({ view: "runs" });
  });
  it("restores Show superseded and the list scroll after a visit to Draft", async () => {
    served.items = [
      execution("exec_live", "completed"),
      execution("exec_old", "superseded"),
    ];
    served.supersededCount = 1;
    const { view, title, rows, back, show, listScroller } =
      await renderRunsReveal({ view: "runs", executionId: "exec_live" });
    await waitFor(() => expect(title()).toBe("Run #2"));
    back();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(view.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const list = listScroller();
    if (!list) {
      throw new Error("the run list did not render");
    }
    list.scrollTop = 80;
    fireEvent.scroll(list);
    fireEvent(list, new Event("scrollend"));

    await show({});
    expect(view.queryByTestId("runs-browse")).toBeNull();
    await show({ view: "runs" });

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(view.getByRole("button", { name: "Hide" })).toBeTruthy();
    await waitFor(() => expect(listScroller()?.scrollTop).toBe(80));
  });
});
