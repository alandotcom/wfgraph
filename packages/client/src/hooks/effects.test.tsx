import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";
import {
  useAbortableSubscription,
  useAbortableTask,
  useAfterDelay,
  useAfterPaint,
  useBeforePaint,
} from "./effects";

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

describe("useAbortableSubscription", () => {
  test("delivers values and aborts the owned iterator on unmount", async () => {
    const seen: number[] = [];
    const subscribed = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<IteratorResult<number, void>>();
    let signal: AbortSignal | undefined;
    let nextCall = 0;

    function Subscriber() {
      useAbortableSubscription({
        key: "draft",
        subscribe: async (nextSignal) => {
          signal = nextSignal;
          subscribed.resolve();
          const iterator: AsyncIterableIterator<number> = {
            [Symbol.asyncIterator]() {
              return iterator;
            },
            next: async () => {
              nextCall += 1;
              return nextCall === 1
                ? { done: false as const, value: 2 }
                : pending.promise;
            },
            return: async () => {
              returned.resolve();
              return { done: true as const, value: undefined };
            },
          };
          return iterator;
        },
        onValue: (value) => {
          seen.push(value);
        },
        onError: (error) => {
          throw error;
        },
      });
      return null;
    }

    const view = render(<Subscriber />);
    await subscribed.promise;
    await vi.waitFor(() => expect(seen).toEqual([2]));

    view.unmount();

    await returned.promise;
    expect(signal?.aborted).toBe(true);
  });

  test("closes an iterator acquired after its owner unmounts", async () => {
    const subscription = Promise.withResolvers<AsyncIterableIterator<number>>();
    const returned = Promise.withResolvers<void>();
    const iterator: AsyncIterableIterator<number> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: () => new Promise<IteratorResult<number>>(() => undefined),
      return: async () => {
        returned.resolve();
        return { done: true as const, value: undefined };
      },
    };

    function Subscriber() {
      useAbortableSubscription({
        key: "draft",
        subscribe: () => subscription.promise,
        onValue: () => undefined,
        onError: (error) => {
          throw error;
        },
      });
      return null;
    }

    const view = render(<Subscriber />);
    view.unmount();
    subscription.resolve(iterator);

    await returned.promise;
  });

  test("does not deliver a pending value after its owner unmounts", async () => {
    const pending = Promise.withResolvers<IteratorResult<number, void>>();
    const seen: number[] = [];
    const iterator: AsyncIterableIterator<number> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: () => pending.promise,
      return: async () => ({ done: true as const, value: undefined }),
    };

    function Subscriber() {
      useAbortableSubscription({
        key: "draft",
        subscribe: async () => iterator,
        onValue: (value) => seen.push(value),
        onError: (error) => {
          throw error;
        },
      });
      return null;
    }

    const view = render(<Subscriber />);
    await Promise.resolve();
    view.unmount();
    pending.resolve({ done: false, value: 2 });
    await Promise.resolve();

    expect(seen).toEqual([]);
  });
});

describe("useAbortableTask", () => {
  test("aborts the previous task when its key changes", async () => {
    const signals: AbortSignal[] = [];

    function Task({ revision }: { revision: number }) {
      useAbortableTask({
        key: revision,
        run: async (signal) => {
          signals.push(signal);
          await new Promise<void>(() => undefined);
        },
        onError: (error) => {
          throw error;
        },
      });
      return null;
    }

    const view = render(<Task revision={1} />);
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    view.rerender(<Task revision={2} />);
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
