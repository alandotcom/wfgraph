import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canvasRevealAtom } from "#src/components/workflow/canvas-reveal/canvas-reveal-state";
import { selectedNodeAtom } from "#src/lib/workflow-graph-store";
import {
  afterPaint,
  execution,
  installRunsRevealRpc,
  labelledGraph,
  log,
  removeRunsRevealRpc,
  renderRunsReveal,
  served,
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

const STEPS = [
  { id: "lookup", label: "Look up patient" },
  { id: "send", label: "Send reminder" },
  { id: "wait", label: "Wait for reply" },
  { id: "notify", label: "Notify staff" },
];

const GROUP = {
  id: "grp",
  label: "Outreach",
  members: ["lookup", "send", "wait"],
};

/** lookup -> send -> wait inside the Group, continuing to notify. */
const CONTINUING = [
  ["lookup", "send"],
  ["send", "wait"],
  ["wait", "notify"],
] as const;

describe("Runs Group summary", () => {
  it("summarizes a failed Group from its members and opens a member's evidence on the one canvas", async () => {
    served.items = [execution("exec_f", "failed")];
    served.graphs = { ver_exec_f: labelledGraph(STEPS, GROUP, CONTINUING) };
    served.logsByExecutionId = {
      exec_f: [
        log({
          id: "log_lookup",
          nodeId: "lookup",
          nodeName: "Look up patient",
          status: "success",
        }),
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "error",
          error: "SMTP refused the message",
          startedAt: "2026-03-01T10:00:01.000Z",
        }),
      ],
    };
    const { view, store, router, aside, title, evidence, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_f" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_f")));

    fireEvent.click(await canvasNode("Outreach"));
    const summary = await view.findByTestId("runs-group-summary");
    expect(aside()?.dataset.level).toBe("browse");
    expect(title()).toBe("Outreach");
    expect(aside()?.querySelector("header")?.textContent).toContain("Failed");
    expect(
      within(summary).getByText("2 of 3 steps reached, 1 failed")
    ).toBeTruthy();
    expect(summary.textContent).not.toMatch(/%/);
    const steps = within(summary).getByRole("list", {
      name: "Steps in this Group",
    });
    expect(
      within(steps)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([
      "Look up patient, Completed",
      "Send reminder, Failed",
      "Wait for reply, Not run",
    ]);
    // The run overview stays mounted behind the summary, hidden.
    expect(
      view.container
        .querySelector('[data-slot="run-overview"]')
        ?.closest("[hidden]")
    ).not.toBeNull();

    fireEvent.click(
      within(steps).getByRole("button", { name: "Send reminder, Failed" })
    );
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(router.state.location.search).toEqual({
      view: "runs",
      executionId: "exec_f",
    });
    expect(store.get(selectedNodeAtom)).toBe("send");
    expect(title()).toBe("Send reminder");
    expect(
      within(evidence()).getByText("SMTP refused the message")
    ).toBeTruthy();
  });

  it("unwinds Escape from member evidence opened through the summary to the run and then the run list", async () => {
    served.items = [execution("exec_e", "failed")];
    served.graphs = { ver_exec_e: labelledGraph(STEPS, GROUP, CONTINUING) };
    served.logsByExecutionId = {
      exec_e: [
        log({
          id: "log_send",
          nodeId: "send",
          nodeName: "Send reminder",
          status: "error",
        }),
      ],
    };
    const { view, store, router, aside, title, escape, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_e" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_e")));

    fireEvent.click(await canvasNode("Outreach"));
    const summary = await view.findByTestId("runs-group-summary");
    fireEvent.click(
      within(summary).getByRole("button", { name: "Send reminder, Failed" })
    );
    await waitFor(() => expect(aside()?.dataset.level).toBe("focus"));
    expect(title()).toBe("Send reminder");

    // Focus steps back to the run's Browse, with the step selected.
    escape();
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    expect(store.get(selectedNodeAtom)).toBe("send");
    expect(title()).toBe(runHeading("exec_e"));
    expect(view.queryByTestId("runs-group-summary")).toBeNull();

    // Focus went back to the step's card on the canvas. An Escape from inside
    // the card returns the run overview to the run list, which opens no
    // Inspector.
    escape(aside());
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ view: "runs" })
    );
    expect(title()).toBeUndefined();
  });

  it("shows a terminal Group as Completed once the run completed, and Back returns to the run with focus on the card", async () => {
    served.items = [execution("exec_s", "completed")];
    served.graphs = {
      ver_exec_s: labelledGraph(STEPS, GROUP, [
        ["lookup", "send"],
        ["send", "wait"],
      ]),
    };
    served.logsByExecutionId = {
      exec_s: ["lookup", "send", "wait"].map((nodeId) =>
        log({
          id: `log_${nodeId}`,
          nodeId,
          nodeName: nodeId,
          status: "success",
        })
      ),
    };
    const { view, store, aside, title, back, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_s" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_s")));

    const card = await canvasNode("Outreach");
    card.focus();
    fireEvent.click(card);
    const summary = await view.findByTestId("runs-group-summary");
    expect(aside()?.querySelector("header")?.textContent).toContain(
      "Completed"
    );
    expect(within(summary).getByText("3 of 3 steps reached")).toBeTruthy();

    back();
    await waitFor(() => expect(title()).toBe(runHeading("exec_s")));
    expect(store.get(selectedNodeAtom)).toBeNull();
    expect(aside()?.dataset.level).toBe("browse");
    expect(view.queryByTestId("runs-group-summary")).toBeNull();
    expect(
      view.container
        .querySelector('[data-slot="run-overview"]')
        ?.closest("[hidden]")
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("shows a waiting Group that has not continued and returns to the run on Back, and keeps a continuing Group Reached without later evidence", async () => {
    served.items = [
      execution("exec_w", "waiting"),
      execution("exec_r", "exited"),
    ];
    served.graphs = {
      ver_exec_w: labelledGraph(STEPS, GROUP, CONTINUING),
      ver_exec_r: labelledGraph(STEPS, GROUP, CONTINUING),
    };
    served.logsByExecutionId = {
      exec_w: [
        log({
          id: "log_lookup",
          nodeId: "lookup",
          nodeName: "Look up patient",
          status: "success",
        }),
        log({
          id: "log_wait",
          nodeId: "wait",
          nodeName: "Wait for reply",
          status: "running",
          startedAt: "2026-03-01T10:00:02.000Z",
        }),
      ],
      exec_r: [
        log({
          id: "log_lookup_r",
          nodeId: "lookup",
          nodeName: "Look up patient",
          status: "success",
        }),
      ],
    };
    served.waitsByExecutionId = {
      exec_w: [
        {
          id: "wait_1",
          nodeId: "wait",
          nodeName: "Wait for reply",
          waitType: "event",
          resumeToken: "tok_w",
          subscribedEvents: ["app/reply"],
          waitUntil: null,
        },
      ],
    };
    const { view, store, aside, title, back, show, canvasNode } =
      await renderRunsReveal({ view: "runs", executionId: "exec_w" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_w")));

    fireEvent.click(await canvasNode("Outreach"));
    await waitFor(() => expect(aside()?.dataset.level).toBe("browse"));
    const summary = await view.findByTestId("runs-group-summary");
    expect(store.get(canvasRevealAtom).subject?.nodeId).toBe("grp");
    expect(aside()?.querySelector("header")?.textContent).toContain("Waiting");
    expect(
      within(summary).getByText("2 of 3 steps reached, 1 waiting")
    ).toBeTruthy();
    expect(
      within(summary).getByRole("button", { name: "Wait for reply, Waiting" })
    ).toBeTruthy();

    back();
    await waitFor(() => expect(title()).toBe(runHeading("exec_w")));
    expect(view.queryByTestId("runs-group-summary")).toBeNull();

    await show({ view: "runs", executionId: "exec_r" });
    await waitFor(() => expect(title()).toBe(runHeading("exec_r")));
    fireEvent.click(await canvasNode("Outreach"));
    await waitFor(() =>
      expect(aside()?.querySelector("header")?.textContent).toContain("Reached")
    );
    await afterPaint();
    expect(
      within(view.getByTestId("runs-group-summary")).getByText(
        "1 of 3 steps reached"
      )
    ).toBeTruthy();
  });
});
