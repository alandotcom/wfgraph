import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { RoutingPolicyEditor } from "#src/components/workflow/config/routing-policy-editor";
import type { RoutingPolicy } from "@rova/shared/workflow/routing-policy";

/**
 * The editor takes its whole world through props, so these render it directly
 * rather than through the trigger panel that usually owns it.
 */

const STALE_ROW_COPY = "Not produced by this trigger anymore. Remove it.";
const EMPTY_COPY = "No event types yet. Add one below and choose what it does.";
const NOT_TRIGGERABLE_COPY =
  "Nothing is mapped to Start or Replace, so this workflow can never be triggered.";

function renderEditor(props: {
  policy: RoutingPolicy | undefined;
  eventTypes: string[] | undefined;
  showTriggerabilityWarning?: boolean;
}) {
  const onChange = vi.fn((_policy: RoutingPolicy) => undefined);
  const view = render(
    <RoutingPolicyEditor
      disabled={false}
      eventTypes={props.eventTypes}
      onChange={onChange}
      policy={props.policy}
      showTriggerabilityWarning={props.showTriggerabilityWarning}
    />
  );

  return { view, onChange };
}

describe("RoutingPolicyEditor with a closed vocabulary", () => {
  it("renders every known Event Type plus a stale row for one the trigger dropped", () => {
    const { view } = renderEditor({
      eventTypes: ["a", "b"],
      policy: { a: "start", gone: "cancel" },
    });

    // Every known Event Type gets a row whether or not the policy mentions it,
    // so the builder sees the whole decision space at once.
    expect(view.getByLabelText("Action for a")).toBeTruthy();
    expect(view.getByLabelText("Action for b")).toBeTruthy();
    expect(view.getByLabelText("Action for gone")).toBeTruthy();
    expect(view.getByText(STALE_ROW_COPY)).toBeTruthy();
  });

  it("removes only the stale mapping when its remove button is clicked", () => {
    const { view, onChange } = renderEditor({
      eventTypes: ["a", "b"],
      policy: { a: "start", gone: "cancel" },
    });

    fireEvent.click(view.getByRole("button", { name: "Remove gone" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual({ a: "start" });
  });

  // A closed vocabulary's rows are not the builder's to delete; only the stale
  // ones, which exist to be cleaned up, carry a remove button.
  it("offers no remove button for an Event Type the trigger still produces", () => {
    const { view } = renderEditor({
      eventTypes: ["a", "b"],
      policy: { a: "start" },
    });

    expect(view.queryByRole("button", { name: "Remove a" })).toBeNull();
  });
});

describe("RoutingPolicyEditor with an open vocabulary", () => {
  it("explains the empty state when nothing is mapped yet", () => {
    const { view } = renderEditor({ eventTypes: undefined, policy: {} });

    expect(view.getByText(EMPTY_COPY)).toBeTruthy();
  });
});

describe("RoutingPolicyEditor triggerability warning", () => {
  it("warns when no Event Type can produce a run", () => {
    const { view } = renderEditor({
      eventTypes: undefined,
      policy: { "entity.deleted": "cancel", "entity.noisy": "ignore" },
    });

    expect(view.getByText(NOT_TRIGGERABLE_COPY)).toBeTruthy();
  });

  it("stays quiet once an Event Type is mapped to Start", () => {
    const { view } = renderEditor({
      eventTypes: undefined,
      policy: { "entity.created": "start", "entity.deleted": "cancel" },
    });

    expect(view.queryByText(NOT_TRIGGERABLE_COPY)).toBeNull();
  });

  // The webhook panel raises the same warning in its own warnings block, so it
  // turns this one off rather than saying it twice.
  it("stays quiet when the surrounding panel owns the warning", () => {
    const { view } = renderEditor({
      eventTypes: undefined,
      policy: { "entity.deleted": "cancel" },
      showTriggerabilityWarning: false,
    });

    expect(view.queryByText(NOT_TRIGGERABLE_COPY)).toBeNull();
  });
});
