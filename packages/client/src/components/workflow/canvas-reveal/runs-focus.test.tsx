import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAuthorizationGrantsForTests } from "#src/lib/authorization-test-support";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  activeChosenExecutionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import {
  WfGraphOperationIds,
  WfGraphOperations,
} from "@wfgraph/shared/authorization/operations";
import {
  afterPaint,
  execution,
  installRunsRevealRpc,
  labelledGraph,
  log,
  removeRunsRevealRpc,
  renderRunsReveal,
  runsRpc,
  served,
  serveEvents,
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

describe("Runs Focus node evidence", () => {
  it("opens the same evidence from a canvas node and its journey entry, and returns to each", async () => {
    served.items = [execution("exec_s", "completed")];
    served.graphs = {
      ver_exec_s: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_s: [
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
          input: { to: "patient@example.com" },
          output: { messageId: "msg_42" },
        }),
      ],
    };
    const {
      view,
      store,
      aside,
      title,
      path,
      escape,
      evidence,
      canvasNode,
      overviewScroller,
    } = await renderRunsReveal({ view: "runs", executionId: "exec_s" });
    await waitFor(() => expect(title()).toBe("Run #1"));

    const node = await canvasNode("Send reminder");
    node.focus();
    fireEvent.click(node);
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Send reminder");
    expect(path()).toBe(
      "Appointment reminders › Runs › Run #1 › Send reminder"
    );
    expect(aside()?.querySelector("header")?.textContent).toContain("Success");
    expect(view.getByRole("button", { name: "Return to run" })).toBeTruthy();
    expect(within(evidence()).getByText(/patient@example.com/)).toBeTruthy();
    expect(within(evidence()).getAllByText(/msg_42/).length).toBeGreaterThan(0);
    expect(store.get(selectedNodeAtom)).toBe("send");
    expect(view.queryByRole("heading", { name: "Node journey" })).toBeNull();

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    await waitFor(() => expect(document.activeElement).toBe(node));
    expect(view.getByRole("button", { name: "Show evidence" })).toBeTruthy();

    const overview = overviewScroller();
    if (!overview) {
      throw new Error("the run overview did not render");
    }
    overview.scrollTop = 90;
    fireEvent.scroll(overview);
    fireEvent(overview, new Event("scrollend"));
    const entry = view.getByRole("button", { name: "Send reminder, Success" });
    fireEvent.click(entry);
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Send reminder");
    expect(within(evidence()).getByText(/patient@example.com/)).toBeTruthy();
    expect(store.get(selectedNodeAtom)).toBe("send");

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Send reminder, Success" })
      )
    );
    await afterPaint();
    expect(overviewScroller()?.scrollTop).toBe(90);
    expect(title()).toBe("Run #1");
  });

  it("shows a failed node's error", async () => {
    served.items = [execution("exec_f", "failed")];
    served.graphs = {
      ver_exec_f: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
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
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_f",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(aside()?.querySelector("header")?.textContent).toContain("Error");
    expect(
      within(evidence()).getByRole("heading", { name: "Error" })
    ).toBeTruthy();
    expect(
      within(evidence()).getByText("SMTP refused the message")
    ).toBeTruthy();
  });

  it("shows a waiting node's wait with Resume, and says the run is still polling", async () => {
    served.items = [execution("exec_w", "waiting")];
    served.graphs = {
      ver_exec_w: labelledGraph([{ id: "w", label: "Wait for reply" }]),
    };
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
          resumeToken: "tok_w",
          subscribedEvents: ["app/reply"],
          waitUntil: null,
        },
      ],
    };
    serveEvents([
      {
        id: "evt_wait",
        eventType: "run_waiting",
        message: "Run waiting in event node 'Wait for reply'",
        metadata: { nodeId: "w", attempt: 1 },
        createdAt: "2026-03-01T10:00:01.000Z",
      },
    ]);
    const { view, aside, title, evidence, canvasNode } = await renderRunsReveal(
      { view: "runs", executionId: "exec_w" }
    );
    await waitFor(() => expect(title()).toBe("Run #1"));

    fireEvent.click(await canvasNode("Wait for reply"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const shown = within(evidence());
    expect(
      shown.getByText(
        "This run is in progress. Its evidence refreshes every 2 seconds."
      )
    ).toBeTruthy();
    expect(
      shown.getByText(
        "This execution has not finished, so its record is incomplete."
      )
    ).toBeTruthy();
    expect(shown.getByText("Waiting for app/reply")).toBeTruthy();
    expect(
      await shown.findByText("Run waiting in event node 'Wait for reply'")
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Resume now" }));
    await waitFor(() =>
      expect(
        runsRpc.calls.some(
          (call) =>
            call.path === "workflow/resumeWait" && call.input.token === "tok_w"
        )
      ).toBe(true)
    );
  });

  it("shows how a resumed node's wait ended", async () => {
    served.items = [execution("exec_r", "completed")];
    served.graphs = {
      ver_exec_r: labelledGraph([{ id: "w", label: "Wait for reply" }]),
    };
    served.logsByExecutionId = {
      exec_r: [
        log({
          id: "log_w",
          nodeId: "w",
          nodeName: "Wait for reply",
          status: "success",
        }),
      ],
    };
    serveEvents([
      {
        id: "evt_resumed",
        eventType: "run_resumed",
        message: "Run resumed from the runs panel",
        metadata: { nodeId: "w", hops: 0, waitStateId: "wait_1" },
        createdAt: "2026-03-01T10:00:05.000Z",
      },
      {
        id: "evt_wait",
        eventType: "run_waiting",
        message: "Run waiting in event node 'Wait for reply'",
        metadata: { nodeId: "w", attempt: 1 },
        createdAt: "2026-03-01T10:00:01.000Z",
      },
    ]);
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_r",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    fireEvent.click(await canvasNode("Wait for reply"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const activity = await within(evidence()).findByText(
      "Run resumed from the runs panel"
    );
    const entries = activity.closest("ol")?.querySelectorAll("li") ?? [];
    expect([...entries].map((entry) => entry.firstChild?.textContent)).toEqual([
      "Run waiting in event node 'Wait for reply'",
      "Run resumed from the runs panel",
    ]);
    expect(within(evidence()).queryByText("Resume now")).toBeNull();
  });

  it("shows a cancelled node's cancellation", async () => {
    served.items = [execution("exec_c", "canceled")];
    served.graphs = {
      ver_exec_c: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_c: [
        log({
          id: "log_c",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "running",
        }),
      ],
    };
    serveEvents([
      {
        id: "evt_cancel",
        eventType: "run_cancelled",
        message: "Run canceled by a Cancel Event",
        metadata: null,
        createdAt: "2026-03-01T10:00:03.000Z",
      },
    ]);
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_c",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Cancelled"
    );
    const shown = within(evidence());
    expect(shown.getByRole("heading", { name: "Cancellation" })).toBeTruthy();
    expect(
      shown.getByText("Run cancelled before step completion")
    ).toBeTruthy();
    expect(
      await shown.findByText(/Run canceled by a Cancel Event/)
    ).toBeTruthy();
    expect(
      shown.queryByText(
        "This run is in progress. Its evidence refreshes every 2 seconds."
      )
    ).toBeNull();
  });

  it("chooses among a node's executions without changing the canvas selection or focus, and restores the choice after a visit to Draft", async () => {
    served.items = [execution("exec_m", "completed")];
    served.graphs = {
      ver_exec_m: labelledGraph([
        { id: "loop", label: "Loop step" },
        { id: "send", label: "Send reminder" },
      ]),
    };
    // The engine writes one row each time a run reaches a node. The second row
    // for "loop" is the same node reached again by a branch run, which opens a
    // row of its own; a retry inside one execution rewrites its row instead.
    served.logsByExecutionId = {
      exec_m: [
        log({
          id: "log_first",
          nodeId: "loop",
          nodeName: "Loop step",
          status: "success",
          output: { pass: "first" },
          startedAt: "2026-03-01T10:00:00.000Z",
        }),
        log({
          id: "log_branch",
          nodeId: "loop",
          nodeName: "Loop step",
          status: "error",
          error: "The branch run's pass was refused",
          startedAt: "2026-03-01T10:00:02.000Z",
        }),
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
          startedAt: "2026-03-01T10:00:04.000Z",
        }),
      ],
    };
    const { view, store, aside, title, show, evidence, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_m" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    await canvasNode("Loop step");

    fireEvent.click(view.getByRole("button", { name: "Loop step, Success" }));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(
      within(evidence()).getByRole("heading", { name: "Execution 1 of 2" })
    ).toBeTruthy();
    expect(
      within(evidence()).getByText(
        "Retries inside one execution are shown as that execution's final outcome."
      )
    ).toBeTruthy();
    const scroller = evidence().parentElement;
    if (!scroller) {
      throw new Error("the evidence has no scroll container");
    }
    scroller.scrollTop = 140;

    const second = view.getByRole("button", { name: /Execution 2/ });
    second.focus();
    fireEvent.click(second);
    await waitFor(() =>
      expect(
        within(evidence()).getByRole("heading", { name: "Execution 2 of 2" })
      ).toBeTruthy()
    );
    expect(document.activeElement).toBe(second);
    expect(evidence().parentElement).toBe(scroller);
    expect(scroller.scrollTop).toBe(0);
    expect(
      within(evidence()).getByText("The branch run's pass was refused")
    ).toBeTruthy();
    expect(store.get(selectedNodeAtom)).toBe("loop");
    expect(aside()?.querySelector("header")?.textContent).toContain("Error");

    await show({});
    expect(view.queryByTestId("runs-browse")).toBeNull();
    await show({ view: "runs", executionId: "exec_m" });
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    await waitFor(() =>
      expect(
        within(evidence()).getByRole("heading", { name: "Execution 2 of 2" })
      ).toBeTruthy()
    );
    expect(store.get(selectedNodeAtom)).toBe("loop");

    fireEvent.click(view.getByRole("button", { name: /Execution 1/ }));
    await waitFor(() =>
      expect(
        within(evidence()).getByRole("heading", { name: "Execution 1 of 2" })
      ).toBeTruthy()
    );
    const send = await canvasNode("Send reminder");
    send.focus();
    fireEvent.click(send);
    await waitFor(() => expect(title()).toBe("Send reminder"));
    expect(aside()?.dataset.level).toBe("focus");
    expect(document.activeElement).toBe(send);
    expect(
      within(evidence()).queryByRole("list", { name: "Executions" })
    ).toBeNull();

    fireEvent.click(await canvasNode("Loop step"));
    await waitFor(() => expect(title()).toBe("Loop step"));
    expect(
      within(evidence()).getByRole("heading", { name: "Execution 2 of 2" })
    ).toBeTruthy();
  });

  it("shows no evidence for a Group card", async () => {
    served.items = [execution("exec_g", "completed")];
    served.graphs = {
      ver_exec_g: labelledGraph([{ id: "send", label: "Send reminder" }], {
        id: "grp",
        label: "Reminders",
        members: ["send"],
      }),
    };
    served.logsByExecutionId = {
      exec_g: [
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
        }),
      ],
    };
    const { view, store, aside, title, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_g",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    fireEvent.click(await canvasNode("Reminders"));
    await waitFor(() => expect(store.get(selectedNodeAtom)).toBe("grp"));
    await afterPaint();
    expect(aside()?.dataset.level).toBe("browse");
    expect(title()).toBe("Run #1");
    expect(view.queryByTestId("run-node-evidence")).toBeNull();
    expect(view.queryByRole("button", { name: "Show evidence" })).toBeNull();
    expect(view.getByText("Node journey")).toBeTruthy();
  });

  it("explains a removed node and a node that never ran", async () => {
    served.items = [execution("exec_x", "completed")];
    served.graphs = {
      ver_exec_x: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_x: [
        log({
          id: "log_gone",
          nodeId: "gone",
          nodeName: "Old step",
          status: "success",
        }),
      ],
    };
    const { view, store, aside, title, escape, evidence, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_x" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    await canvasNode("Send reminder");

    fireEvent.click(view.getByRole("button", { name: "Old step, Success" }));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Old step");
    expect(store.get(selectedNodeAtom)).toBeNull();
    const shown = within(evidence());
    expect(
      shown.getByText("This step is not in the graph this run uses.")
    ).toBeTruthy();
    expect(
      shown.getByText("The configuration this run used is unavailable.")
    ).toBeTruthy();
    await afterPaint();
    expect(aside()?.dataset.level).toBe("focus");

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Old step, Success" })
      )
    );

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(title()).toBe("Send reminder"));
    expect(
      within(evidence()).getByText("This step did not run in this run.")
    ).toBeTruthy();
    expect(
      within(evidence()).getByRole("heading", { name: "Configuration" })
    ).toBeTruthy();
    expect(aside()?.querySelector("header")?.textContent).toContain("Not run");
  });

  it("says when the graph a run used cannot be loaded", async () => {
    installAuthorizationGrantsForTests(
      WfGraphOperationIds.filter(
        (id) => id !== WfGraphOperations.workflowGetVersionGraph.id
      )
    );
    served.items = [execution("exec_u", "completed")];
    served.logsByExecutionId = {
      exec_u: [
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
        }),
      ],
    };
    const { view, aside, title, evidence } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_u",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));

    fireEvent.click(
      view.getByRole("button", { name: "Send reminder, Success" })
    );
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(
      within(evidence()).getByText(
        "The graph this run used could not be loaded, so its configuration is unavailable."
      )
    ).toBeTruthy();
    expect(title()).toBe("Send reminder");
  });

  it("enters a collapsed Group's view for a member reached from the journey on the overview", async () => {
    served.items = [execution("exec_g", "completed")];
    served.graphs = {
      ver_exec_g: labelledGraph(
        [
          { id: "send", label: "Send reminder" },
          { id: "notify", label: "Notify staff" },
        ],
        { id: "grp", label: "Reminders", members: ["send"] }
      ),
    };
    served.logsByExecutionId = {
      exec_g: [
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
        }),
      ],
    };
    const { view, store, router, aside, title, escape, evidence, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_g" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    await canvasNode("Send reminder");

    fireEvent.click(
      view.getByRole("button", { name: "Send reminder, Success" })
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        view: "runs",
        executionId: "exec_g",
        group: "grp",
      })
    );
    expect(router.history.canGoBack()).toBe(true);
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    await afterPaint();
    expect(store.get(activeWorkspaceAddressAtom).scope).toEqual({
      kind: "group",
      groupId: "grp",
    });
    expect(store.get(selectedNodeAtom)).toBe("send");
    expect(title()).toBe("Send reminder");
    expect(
      within(evidence()).getByRole("heading", { name: "Execution" })
    ).toBeTruthy();

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole("button", { name: "Send reminder, Success" })
      )
    );
  });

  it("returns straight to Closed after a canvas click opened Focus from Closed, and keeps the saved preference", async () => {
    served.items = [execution("exec_s", "completed")];
    served.graphs = {
      ver_exec_s: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_s: [
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
        }),
      ],
    };
    const { view, aside, title, escape, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_s",
    });
    await waitFor(() => expect(title()).toBe("Run #1"));
    const preference = () =>
      document.cookie
        .split("; ")
        .find((entry) => entry.startsWith("sidebar-collapsed="));

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(aside()?.dataset.level).toBe("closed"));
    expect(preference()).toBe("sidebar-collapsed=true");

    const node = await canvasNode("Send reminder");
    node.focus();
    fireEvent.click(node);
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Send reminder");

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("closed"));
    await waitFor(() => expect(document.activeElement).toBe(node));
    expect(preference()).toBe("sidebar-collapsed=true");

    fireEvent.click(view.getByRole("button", { name: "Open inspector" }));
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    expect(title()).toBe("Run #1");
    expect(preference()).toBe("sidebar-collapsed=false");
  });

  it("dismisses a chosen execution of a node nothing selects with a click on the canvas pane", async () => {
    served.items = [execution("exec_x", "completed")];
    served.graphs = {
      ver_exec_x: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_x: [
        log({
          id: "log_gone",
          nodeId: "gone",
          nodeName: "Old step",
          status: "success",
        }),
      ],
    };
    const { view, store, aside, title, clickPane, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_x" });
    await waitFor(() => expect(title()).toBe("Run #1"));
    await canvasNode("Send reminder");

    fireEvent.click(view.getByRole("button", { name: "Old step, Success" }));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(store.get(activeChosenExecutionAtom)).toEqual({
      nodeId: "gone",
      logId: "log_gone",
    });

    clickPane();
    await waitFor(() => expect(title()).toBe("Run #1"));
    expect(store.get(activeChosenExecutionAtom)).toBeNull();
    expect(view.queryByTestId("run-node-evidence")).toBeNull();
    expect(aside()?.dataset.level).toBe("browse");
  });
});
