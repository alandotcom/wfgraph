import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeOutputConditionPath } from "@wfgraph/shared/conditions/conditions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { installAuthorizationGrantsForTests } from "#src/lib/authorization-test-support";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import { activeChosenExecutionAtom } from "#src/lib/workflow-workspace-navigation";
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
  runHeading,
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

/** What a Continue now on `exec_d`'s Wait posts. */
const CONTINUE_INPUT = { executionId: "exec_d", waitStateId: "wait_exec_d" };

/** The inputs of every Continue now posted so far. */
function continueCalls() {
  return runsRpc.calls
    .filter((call) => call.path === "workflow/continueWait")
    .map((call) => call.input);
}

/**
 * Serves `id` as a run parked on a one-day Wait, a timed one unless `event`
 * says it waits for an Event, of the draft or of a published version.
 */
function serveTimedWait(
  id: string,
  input: { versionKind: "published" | "draft_snapshot"; event?: boolean }
) {
  served.items = [
    ...served.items,
    { ...execution(id, "waiting"), versionKind: input.versionKind },
  ];
  served.graphs = {
    ...served.graphs,
    [`ver_${id}`]: labelledGraph([{ id: "w", label: "Wait a day" }]),
  };
  served.logsByExecutionId = {
    ...served.logsByExecutionId,
    [id]: [
      log({
        id: `log_${id}`,
        nodeId: "w",
        nodeName: "Wait a day",
        status: "running",
      }),
    ],
  };
  served.waitsByExecutionId = {
    ...served.waitsByExecutionId,
    [id]: [
      {
        id: `wait_${id}`,
        nodeId: "w",
        nodeName: "Wait a day",
        waitType: input.event ? "event" : "delay",
        resumeToken: input.event ? `tok_${id}` : null,
        subscribedEvents: input.event ? ["app/reply"] : [],
        waitUntil: "2026-03-02T10:00:00.000Z",
      },
    ],
  };
}

describe("Runs Focus node evidence", () => {
  it("opens the same evidence from a canvas node and its outline row, and returns to each", async () => {
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
      outlineRow,
    } = await renderRunsReveal({ view: "runs", executionId: "exec_s" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_s")));

    const node = await canvasNode("Send reminder");
    node.focus();
    fireEvent.click(node);
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Send reminder");
    expect(path()).toBe(
      `Appointment reminders › Runs › ${runHeading("exec_s")} › Send reminder`
    );
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Completed"
    );
    expect(within(evidence()).getByText(/patient@example.com/)).toBeTruthy();
    expect(within(evidence()).getAllByText(/msg_42/).length).toBeGreaterThan(0);
    expect(store.get(selectedNodeAtom)).toBe("send");
    expect(view.queryByRole("heading", { name: "Node journey" })).toBeNull();

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    await waitFor(() => expect(document.activeElement).toBe(node));

    const overview = overviewScroller();
    if (!overview) {
      throw new Error("the run overview did not render");
    }
    overview.scrollTop = 90;
    fireEvent.scroll(overview);
    fireEvent(overview, new Event("scrollend"));
    const row = await outlineRow("Send reminder");
    fireEvent.click(row);
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Send reminder");
    expect(within(evidence()).getByText(/patient@example.com/)).toBeTruthy();
    expect(store.get(selectedNodeAtom)).toBe("send");

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    await waitFor(async () =>
      expect(document.activeElement).toBe(await outlineRow("Send reminder"))
    );
    await afterPaint();
    expect(overviewScroller()?.scrollTop).toBe(90);
    expect(title()).toBe(runHeading("exec_s"));
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
    await waitFor(() => expect(title()).toBe(runHeading("exec_f")));

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(aside()?.querySelector("header")?.textContent).toContain("Failed");
    expect(
      within(evidence()).getByRole("heading", { name: "Error" })
    ).toBeTruthy();
    expect(
      within(evidence()).getByText("SMTP refused the message")
    ).toBeTruthy();
  });

  // A test run calls the handler, which answers that it sent nothing. The
  // evidence and its header say so instead of Successful.
  it("says a step a test run skipped did nothing, and why", async () => {
    served.items = [{ ...execution("exec_t", "completed"), runMode: "test" }];
    served.graphs = {
      ver_exec_t: labelledGraph([{ id: "thanks", label: "Send thank-you" }]),
    };
    served.logsByExecutionId = {
      exec_t: [
        log({
          id: "log_t",
          nodeId: "thanks",
          nodeName: "Send thank-you",
          status: "success",
          output: { status: "skipped" },
        }),
      ],
    };
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_t",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_t")));

    fireEvent.click(await canvasNode("Send thank-you"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Skipped (test run)"
    );
    expect(
      within(evidence()).getByText("The app skips this step in a test run.")
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
          waitType: "event",
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
    await waitFor(() => expect(title()).toBe(runHeading("exec_w")));

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
        "This step has not finished, so its record is incomplete."
      )
    ).toBeTruthy();
    expect(shown.getByText("Waiting for app/reply")).toBeTruthy();
    expect(await shown.findByText("Waiting at Wait for reply")).toBeTruthy();

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

  // A draft run with a one-day Wait could only be cancelled, so "run it once
  // to see it work" took a day. Continue now ends the Wait and the run goes on.
  it("offers Continue now on a draft run's timed Wait, in the step's evidence and the run overview, and posts the run and the wait", async () => {
    serveTimedWait("exec_d", { versionKind: "draft_snapshot" });
    const { view, aside, title, evidence, canvasNode } = await renderRunsReveal(
      { view: "runs", executionId: "exec_d" }
    );
    await waitFor(() => expect(title()).toBe(runHeading("exec_d")));

    // The run overview names the Wait the run is held at.
    fireEvent.click(await view.findByRole("button", { name: "Continue now" }));
    await waitFor(() => expect(continueCalls()).toEqual([CONTINUE_INPUT]));

    fireEvent.click(await canvasNode("Wait a day"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const shown = within(evidence());
    expect(shown.queryByRole("button", { name: "Resume now" })).toBeNull();
    fireEvent.click(await shown.findByRole("button", { name: "Continue now" }));
    await waitFor(() =>
      expect(continueCalls()).toEqual([CONTINUE_INPUT, CONTINUE_INPUT])
    );
  });

  it("offers no Continue now on a timed Wait of a published run", async () => {
    serveTimedWait("exec_p", { versionKind: "published" });
    const { view, aside, title, evidence, canvasNode } = await renderRunsReveal(
      { view: "runs", executionId: "exec_p" }
    );
    await waitFor(() => expect(title()).toBe(runHeading("exec_p")));
    expect(
      await view.findByRole("heading", { name: "Waiting at Wait a day" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Continue now" })).toBeNull();

    fireEvent.click(await canvasNode("Wait a day"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(
      within(evidence()).queryByRole("button", { name: "Continue now" })
    ).toBeNull();
  });

  // An event Wait already offers Resume now, which ends it with an arrival.
  it("offers Resume now and no Continue now on an event Wait of a draft run", async () => {
    serveTimedWait("exec_e", { versionKind: "draft_snapshot", event: true });
    const { view, title } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_e",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_e")));
    expect(
      await view.findByRole("button", { name: "Resume now" })
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Continue now" })).toBeNull();
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
        message: "Run resumed from the Runs view",
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
    await waitFor(() => expect(title()).toBe(runHeading("exec_r")));

    fireEvent.click(await canvasNode("Wait for reply"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const activity = await within(evidence()).findByText(
      "Run resumed from the Runs view"
    );
    const entries = activity.closest("ol")?.querySelectorAll("li") ?? [];
    expect([...entries].map((entry) => entry.firstChild?.textContent)).toEqual([
      "Waiting at Wait for reply",
      "Run resumed from the Runs view",
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
    await waitFor(() => expect(title()).toBe(runHeading("exec_c")));

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(aside()?.querySelector("header")?.textContent).toContain("Canceled");
    const shown = within(evidence());
    expect(shown.getByRole("heading", { name: "Cancellation" })).toBeTruthy();
    expect(shown.getByText("Run ended before step completion")).toBeTruthy();
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
    const {
      view,
      store,
      aside,
      title,
      show,
      evidence,
      canvasNode,
      outlineRow,
    } = await renderRunsReveal({ view: "runs", executionId: "exec_m" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_m")));
    await canvasNode("Loop step");

    // The row opens the latest execution, as the card does.
    fireEvent.click(await outlineRow("Loop step"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    fireEvent.click(view.getByRole("button", { name: /Time 1/ }));
    await waitFor(() =>
      expect(
        within(evidence()).getByRole("heading", {
          name: "In this run · time 1 of 2",
        })
      ).toBeTruthy()
    );
    const scroller = evidence().parentElement;
    if (!scroller) {
      throw new Error("the evidence has no scroll container");
    }
    scroller.scrollTop = 140;

    const second = view.getByRole("button", { name: /Time 2/ });
    second.focus();
    fireEvent.click(second);
    await waitFor(() =>
      expect(
        within(evidence()).getByRole("heading", {
          name: "In this run · time 2 of 2",
        })
      ).toBeTruthy()
    );
    expect(document.activeElement).toBe(second);
    expect(evidence().parentElement).toBe(scroller);
    expect(scroller.scrollTop).toBe(0);
    expect(
      within(evidence()).getByText("The branch run's pass was refused")
    ).toBeTruthy();
    expect(store.get(selectedNodeAtom)).toBe("loop");
    expect(aside()?.querySelector("header")?.textContent).toContain("Failed");

    await show({});
    expect(view.queryByTestId("runs-browse")).toBeNull();
    await show({ view: "runs", executionId: "exec_m" });
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    await waitFor(() =>
      expect(
        within(evidence()).getByRole("heading", {
          name: "In this run · time 2 of 2",
        })
      ).toBeTruthy()
    );
    expect(store.get(selectedNodeAtom)).toBe("loop");

    fireEvent.click(view.getByRole("button", { name: /Time 1/ }));
    await waitFor(() =>
      expect(
        within(evidence()).getByRole("heading", {
          name: "In this run · time 1 of 2",
        })
      ).toBeTruthy()
    );
    const send = await canvasNode("Send reminder");
    send.focus();
    fireEvent.click(send);
    await waitFor(() => expect(title()).toBe("Send reminder"));
    expect(aside()?.dataset.level).toBe("focus");
    expect(document.activeElement).toBe(send);
    expect(
      within(evidence()).queryByRole("list", { name: "Times this step ran" })
    ).toBeNull();

    fireEvent.click(await canvasNode("Loop step"));
    await waitFor(() => expect(title()).toBe("Loop step"));
    expect(
      within(evidence()).getByRole("heading", {
        name: "In this run · time 2 of 2",
      })
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
    await waitFor(() => expect(title()).toBe(runHeading("exec_g")));

    fireEvent.click(await canvasNode("Reminders"));
    await waitFor(() => expect(store.get(selectedNodeAtom)).toBe("grp"));
    await afterPaint();
    expect(aside()?.dataset.level).toBe("browse");
    expect(title()).toBe("Reminders");
    expect(view.queryByTestId("run-node-evidence")).toBeNull();
    expect(view.queryByRole("button", { name: "Show evidence" })).toBeNull();
    expect(view.getByTestId("runs-group-summary")).toBeTruthy();
  });

  // A Condition's evidence leads with the branch it took, then reads each rule
  // as a sentence, and keeps the compiled expression behind Show raw data.
  it("reads a Condition's evidence as the decision it made", async () => {
    const remindersOn = nodeOutputConditionPath("lookup", "remindersOn") ?? "";
    served.items = [execution("exec_c", "completed")];
    served.graphs = {
      ver_exec_c: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "lookup",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Look up visit",
              type: "action",
              config: { actionType: "host/lookup" },
            },
          },
          {
            id: "check",
            type: "action",
            position: { x: 0, y: 200 },
            data: {
              label: "Reminders on?",
              type: "action",
              config: {
                actionType: "Condition",
                condition: `${remindersOn} == true`,
                conditionModel: JSON.stringify({
                  version: 2,
                  groupLogic: "and",
                  groups: [
                    {
                      id: "group_1",
                      logic: "and",
                      conditions: [
                        {
                          id: "rule_on",
                          field: remindersOn,
                          fieldType: "boolean",
                          operator: "is_true",
                        },
                      ],
                    },
                  ],
                }),
              },
            },
          },
          {
            id: "remind",
            type: "action",
            position: { x: 0, y: 400 },
            data: {
              label: "Send reminder",
              type: "action",
              config: { actionType: "host/send" },
            },
          },
        ],
        edges: [
          { id: "e_lookup", source: "lookup", target: "check" },
          {
            id: "e_true",
            source: "check",
            target: "remind",
            sourceHandle: "true",
          },
        ],
      }),
    };
    served.logsByExecutionId = {
      exec_c: [
        log({
          id: "log_lookup",
          nodeId: "lookup",
          nodeName: "Look up visit",
          status: "success",
          output: { remindersOn: false },
        }),
        log({
          id: "log_check",
          nodeId: "check",
          nodeName: "Reminders on?",
          status: "success",
          startedAt: "2026-03-01T10:00:01.000Z",
          input: { condition: false, expression: `${remindersOn} == true` },
          output: { condition: false },
        }),
      ],
    };
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_c",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_c")));

    fireEvent.click(await canvasNode("Reminders on?"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const shown = within(evidence());
    expect(shown.getByText("Took False")).toBeTruthy();
    expect(shown.getByText("The path ends here.")).toBeTruthy();
    expect(
      shown.getByText("True when the rule matches, and False otherwise.")
    ).toBeTruthy();
    expect(shown.getByText("Did not match")).toBeTruthy();
    expect(shown.getByText("Value in this run:")).toBeTruthy();
    expect(shown.queryByText(/== true/)).toBeNull();

    fireEvent.click(shown.getByRole("button", { name: "Show raw data" }));
    // The recorded input and the configuration each hold the expression.
    expect(shown.getAllByText(/== true/)).toHaveLength(2);
    expect(shown.getByRole("button", { name: "Hide raw data" })).toBeTruthy();
  });

  it("reads a Condition's rule from the Event that woke the Wait above it, and marks the rule that decided", async () => {
    const amount = nodeOutputConditionPath("booked", "amountCents") ?? "";
    const status = nodeOutputConditionPath("confirm", "status") ?? "";
    const action = (id: string, label: string, y: number, config: object) => ({
      id,
      type: "action",
      position: { x: 0, y },
      data: { label, type: "action" as const, config },
    });
    served.items = [execution("exec_d", "failed")];
    served.graphs = {
      ver_exec_d: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "booked",
            type: "lifecycle",
            position: { x: 0, y: -200 },
            data: { label: "Appointment booked", type: "lifecycle" },
          },
          action("confirm", "Send confirmation", 0, {
            actionType: "host/send",
          }),
          action("deposit", "Wait for deposit", 200, {
            actionType: "Wait",
            waitMode: "event",
            waitFor: [{ event: "billing/payment.settled" }],
          }),
          action("check", "Deposit covers the visit?", 400, {
            actionType: "Condition",
            condition: "true",
            conditionModel: JSON.stringify({
              version: 2,
              groupLogic: "and",
              groups: [
                {
                  id: "group_1",
                  logic: "and",
                  conditions: [
                    {
                      id: "rule_amount",
                      field: amount,
                      fieldType: "number",
                      operator: "greater_or_equal",
                      value: 7500,
                    },
                    {
                      id: "rule_status",
                      field: status,
                      fieldType: "string",
                      operator: "not_equals",
                      value: "failed",
                    },
                  ],
                },
              ],
            }),
          }),
        ],
        edges: [
          {
            id: "e_start",
            source: "booked",
            target: "confirm",
            sourceHandle: "started",
          },
          { id: "e_confirm", source: "confirm", target: "deposit" },
          { id: "e_deposit", source: "deposit", target: "check" },
        ],
      }),
    };
    served.logsByExecutionId = {
      exec_d: [
        log({
          id: "log_booked",
          nodeId: "booked",
          nodeName: "Appointment booked",
          status: "success",
          output: { patientId: "pat_1008" },
        }),
        log({
          id: "log_confirm",
          nodeId: "confirm",
          nodeName: "Send confirmation",
          status: "success",
          startedAt: "2026-03-01T10:00:01.000Z",
          output: { status: "sent" },
        }),
        log({
          id: "log_deposit",
          nodeId: "deposit",
          nodeName: "Wait for deposit",
          status: "success",
          startedAt: "2026-03-01T10:00:02.000Z",
          output: {
            waitType: "event",
            timedOut: false,
            hops: 0,
            event: "billing/payment.settled",
            payload: { amountCents: 2500 },
          },
        }),
        log({
          id: "log_check",
          nodeId: "check",
          nodeName: "Deposit covers the visit?",
          status: "success",
          startedAt: "2026-03-01T10:00:03.000Z",
          input: { condition: false, expression: "true" },
          output: { condition: false },
        }),
      ],
    };
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_d",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_d")));

    fireEvent.click(await canvasNode("Deposit covers the visit?"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const shown = within(evidence());
    expect(shown.getByText("Took False")).toBeTruthy();
    expect(shown.queryByText("Not set in this run")).toBeNull();
    expect(shown.getByText("2500")).toBeTruthy();
    expect(shown.getByText("Did not match")).toBeTruthy();
    expect(shown.getByText("Matched")).toBeTruthy();
    expect(shown.getAllByText("Decided the branch")).toHaveLength(1);
  });

  it("labels a Wait's evidence with its form's words, and leaves the engine's own fields to the raw data", async () => {
    served.items = [execution("exec_w", "completed")];
    served.graphs = {
      ver_exec_w: createSerializedWorkflowGraph({
        nodes: [
          {
            id: "pause",
            type: "action",
            position: { x: 0, y: 0 },
            data: {
              label: "Wait a day",
              type: "action",
              config: { actionType: "Wait", waitMode: "delay" },
            },
          },
        ],
        edges: [],
      }),
    };
    served.logsByExecutionId = {
      exec_w: [
        log({
          id: "log_pause",
          nodeId: "pause",
          nodeName: "Wait a day",
          status: "success",
          input: { waitMode: "delay", waitDuration: "1d", waitGateMode: "off" },
          output: { waitType: "delay", hops: 1 },
        }),
      ],
    };
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_w",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_w")));

    fireEvent.click(await canvasNode("Wait a day"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const shown = within(evidence());
    expect(shown.getByText("How should this step wait?")).toBeTruthy();
    expect(shown.getByText("Wait for time")).toBeTruthy();
    expect(shown.getByText("If the scheduled time has passed")).toBeTruthy();
    expect(shown.getByText("Continue immediately")).toBeTruthy();
    expect(shown.queryByText(/Wait Gate Mode|Hops|Wait Type/u)).toBeNull();

    fireEvent.click(shown.getByRole("button", { name: "Show raw data" }));
    expect(shown.getAllByText(/"hops"/u).length).toBeGreaterThan(0);
  });

  it("shows a step's input and output as labeled values before its raw data", async () => {
    served.items = [execution("exec_s", "completed")];
    served.graphs = {
      ver_exec_s: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_s: [
        log({
          id: "log_s",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "success",
          input: { toAddress: "ada@example.com" },
          output: { messageId: "msg_42" },
        }),
      ],
    };
    const { aside, title, evidence, canvasNode } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_s",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_s")));

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    const shown = within(evidence());
    expect(shown.getByText("To Address")).toBeTruthy();
    expect(shown.getByText("ada@example.com")).toBeTruthy();
    expect(shown.getByText("Message ID")).toBeTruthy();
    expect(shown.queryByRole("button", { name: "Copy" })).toBeNull();

    // The step's record, its input and its output share one label column
    // with the run summary, so their pairs line up down the column.
    const columns = (root: Element) =>
      new Set(
        [...root.querySelectorAll("dt")].map(
          (term) =>
            term.parentElement?.className.match(/grid-cols-\[[^\]]+\]/u)?.[0]
        )
      );
    expect(columns(evidence())).toEqual(
      new Set(["grid-cols-[6.5rem_minmax(0,1fr)]"])
    );

    fireEvent.click(shown.getByRole("button", { name: "Show raw data" }));
    expect(shown.getAllByRole("button", { name: "Copy" })).toHaveLength(3);
    expect(shown.getByText(/"toAddress"/)).toBeTruthy();
  });

  it("explains a removed node and a node that never ran", async () => {
    // A step the graph no longer holds has no row or card, and the failure
    // summary is the way into its evidence.
    served.items = [execution("exec_x", "failed")];
    served.graphs = {
      ver_exec_x: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_x: [
        log({
          id: "log_gone",
          nodeId: "gone",
          nodeName: "Old step",
          status: "error",
          error: "Request failed",
        }),
      ],
    };
    const { view, store, aside, title, escape, evidence, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_x" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_x")));
    await canvasNode("Send reminder");

    fireEvent.click(view.getByRole("button", { name: "Failed at Old step" }));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Old step");
    expect(store.get(selectedNodeAtom)).toBeNull();
    const shown = within(evidence());
    expect(
      shown.getByText("This step is not in the graph this run uses.")
    ).toBeTruthy();
    fireEvent.click(shown.getByRole("button", { name: "Show raw data" }));
    expect(
      shown.getByText("The configuration this run used is unavailable.")
    ).toBeTruthy();
    await afterPaint();
    expect(aside()?.dataset.level).toBe("focus");

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));

    fireEvent.click(await canvasNode("Send reminder"));
    await waitFor(() => expect(title()).toBe("Send reminder"));
    expect(
      within(evidence()).getByText("This step did not run in this run.")
    ).toBeTruthy();
    fireEvent.click(
      within(evidence()).getByRole("button", { name: "Show raw data" })
    );
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
    const { view, title } = await renderRunsReveal({
      view: "runs",
      executionId: "exec_u",
    });
    await waitFor(() => expect(title()).toBe(runHeading("exec_u")));

    await waitFor(() =>
      expect(
        within(view.getByTestId("outline-column")).getByText(
          "The graph this run used could not be loaded, so its steps cannot be listed."
        )
      ).toBeTruthy()
    );
  });

  it("shows a Group member's evidence on the one canvas from its outline row", async () => {
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
    const {
      store,
      router,
      aside,
      title,
      escape,
      evidence,
      canvasNode,
      outlineRow,
    } = await renderRunsReveal({ view: "runs", executionId: "exec_g" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_g")));
    await canvasNode("Send reminder");

    fireEvent.click(await outlineRow("Send reminder"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    await afterPaint();
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_g",
    });
    expect(store.get(selectedNodeAtom)).toBe("send");
    expect(title()).toBe("Send reminder");
    expect(
      within(evidence()).getByRole("heading", { name: "In this run" })
    ).toBeTruthy();

    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    await waitFor(async () =>
      expect(document.activeElement).toBe(await outlineRow("Send reminder"))
    );
  });

  it("dismisses a chosen execution of a node nothing selects with a click on the canvas pane", async () => {
    served.items = [execution("exec_x", "failed")];
    served.graphs = {
      ver_exec_x: labelledGraph([{ id: "send", label: "Send reminder" }]),
    };
    served.logsByExecutionId = {
      exec_x: [
        log({
          id: "log_gone",
          nodeId: "gone",
          nodeName: "Old step",
          status: "error",
          error: "Request failed",
        }),
      ],
    };
    const { view, store, aside, title, clickPane, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_x" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_x")));
    await canvasNode("Send reminder");

    fireEvent.click(view.getByRole("button", { name: "Failed at Old step" }));
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(store.get(activeChosenExecutionAtom)).toEqual({
      nodeId: "gone",
      logId: "log_gone",
    });

    clickPane();
    await waitFor(() => expect(title()).toBe(runHeading("exec_x")));
    expect(store.get(activeChosenExecutionAtom)).toBeNull();
    expect(view.queryByTestId("run-node-evidence")).toBeNull();
    expect(aside()?.dataset.level).toBe("browse");
  });
});
