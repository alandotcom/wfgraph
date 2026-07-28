import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";
import { useAfterPaint } from "./effects";

afterEach(() => {
  cleanup();
});

/** Let the hook's zero-delay timer fire inside React's act scope. */
const flushAfterPaint = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 5)));

describe("useAfterPaint", () => {
  test("callback sees the render that changed the key", async () => {
    const seen: string[] = [];

    function Plain({ label }: { label: string }) {
      useAfterPaint(label, () => {
        seen.push(label);
      });
      return null;
    }

    const { rerender } = render(<Plain label="first" />);
    await flushAfterPaint();
    rerender(<Plain label="second" />);
    await flushAfterPaint();

    expect(seen).toEqual(["first", "second"]);
  });

  // The regression this file exists for. React 19.2's useEffectEvent never
  // refreshes its wrapped closure after mount when the component sits behind
  // memo or forwardRef, so a callback built on it fires with the mount
  // render's values forever. The condition node is memoized, and its
  // useAfterPaint callback saw actionType as it was at mount: empty. The
  // updateNodeInternals call it guards never happened, and React Flow kept
  // the stale single-handle measurement until a full page reload.
  test("callback sees current values inside a memoized component", async () => {
    const seen: string[] = [];

    const Memoized = memo(function Memoized({ label }: { label: string }) {
      useAfterPaint(label, () => {
        seen.push(label);
      });
      return null;
    });

    const { rerender } = render(<Memoized label="first" />);
    await flushAfterPaint();
    rerender(<Memoized label="second" />);
    await flushAfterPaint();

    expect(seen).toEqual(["first", "second"]);
  });
});
