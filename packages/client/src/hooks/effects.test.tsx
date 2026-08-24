import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";
import { useAfterDelay, useAfterPaint, useBeforePaint } from "./effects";

afterEach(() => {
  vi.useRealTimers();
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

describe("useBeforePaint", () => {
  test("runs synchronously after the keyed commit", () => {
    const seen: string[] = [];

    function BeforePaint({ label }: { label: string }) {
      useBeforePaint(label, () => {
        seen.push(label);
      });
      return null;
    }

    const { rerender } = render(<BeforePaint label="draft" />);
    expect(seen).toEqual(["draft"]);

    rerender(<BeforePaint label="runs" />);
    expect(seen).toEqual(["draft", "runs"]);
  });
});

describe("useAfterDelay", () => {
  test("runs only after the delay and cancels a superseded key", () => {
    vi.useFakeTimers();
    const seen: string[] = [];

    function Delayed({ label }: { label: string }) {
      useAfterDelay(label, 100, () => {
        seen.push(label);
      });
      return null;
    }

    const { rerender } = render(<Delayed label="first" />);
    act(() => vi.advanceTimersByTime(50));
    rerender(<Delayed label="second" />);
    act(() => vi.advanceTimersByTime(99));
    expect(seen).toEqual([]);

    act(() => vi.advanceTimersByTime(1));
    expect(seen).toEqual(["second"]);
  });
});
