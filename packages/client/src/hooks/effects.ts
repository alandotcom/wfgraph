import {
  type RefCallback,
  type RefObject,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * The one file in packages/client/src allowed to import useEffect and
 * useLayoutEffect. Everything below turns a raw effect into a named intention,
 * so a reader of a component sees what is being synchronised with the world
 * outside React rather than a dependency array they have to decode.
 *
 * https://react.dev/learn/you-might-not-need-an-effect draws the line these
 * hooks sit on. Nothing here fetches, derives state from props, or writes to a
 * parent. A fetch belongs in a TanStack Query hook, a derived value belongs in
 * render, and a parent notification belongs in the event handler that caused
 * it. If a new hook here would do one of those, it is in the wrong file.
 *
 * There is deliberately no `useMountEffect`. It would be `useEffect(fn, [])`
 * under a friendlier name, with no constraint on what the body may do, and
 * would hollow out the ban that makes this module the only home for effects.
 *
 * Every hook here takes its callback through `useLatestEvent` below, so the
 * callback may be a fresh closure on every render and still not become a
 * dependency of the subscription it drives. Written as raw effects, these call
 * sites had to list their handler and the whole transitive tail of its
 * `useCallback` dependencies, and so tore down and rebuilt their timers and
 * listeners on renders that had nothing to do with the thing being
 * synchronised.
 */

/**
 * A stable function that always invokes the latest render's `fn`.
 *
 * React 19.2 ships `useEffectEvent` for exactly this, but its commit-phase
 * closure swap runs only for plain function-component fibers; under `memo` or
 * `forwardRef` the wrapped closure stays frozen at the mount render for the
 * component's whole life (react-dom 19.2.8 still has this; React main has the
 * fix). The workflow canvas memoises every node component, so a hook built on
 * it fired with mount-time values forever: a condition node added as an empty
 * action never told React Flow about its true/false handles, because the
 * callback still saw the empty action type. The insertion effect below runs on
 * every commit regardless of fiber type. Swap this for `useEffectEvent` only
 * once the released React handles memoised components, and only with
 * effects.test.tsx passing on the exact installed version.
 */
function useLatestEvent<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(fn);
  useInsertionEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}

type AbortableSubscriptionInput<T> = {
  /** Recreate the subscription when this value changes. */
  key: unknown;
  /** Skip the subscription while false. Defaults to true. */
  enabled?: boolean;
  /** Open the external stream owned by the mounted component. */
  subscribe: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
  /** Receive each value while the subscription remains active. */
  onValue: (value: T) => void;
  /** Handle a terminal error that did not come from cancellation. */
  onError: (error: unknown) => void;
};

/** Own an async subscription and close it when its key changes or it unmounts. */
export function useAbortableSubscription<T>(
  input: AbortableSubscriptionInput<T>
): void {
  const subscribe = useLatestEvent(input.subscribe);
  const onValue = useLatestEvent(input.onValue);
  const onError = useLatestEvent(input.onError);
  const enabled = input.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const controller = new AbortController();
    let iterator: AsyncIterator<T> | undefined;

    void (async () => {
      try {
        const iterable = await subscribe(controller.signal);
        iterator = iterable[Symbol.asyncIterator]();
        if (controller.signal.aborted) {
          await iterator.return?.();
          return;
        }

        while (!controller.signal.aborted) {
          // Async iterator reads are ordered and cannot run in parallel.
          // eslint-disable-next-line no-await-in-loop
          const result = await iterator.next();
          if (controller.signal.aborted || result.done) {
            return;
          }
          onValue(result.value);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          onError(error);
        }
      }
    })();

    return () => {
      controller.abort();
      void Promise.resolve(iterator?.return?.()).catch(() => undefined);
    };
  }, [input.key, enabled, subscribe, onValue, onError]);
}

const subscribeToDocumentVisibility = (onStoreChange: () => void) => {
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
};

const getDocumentVisibility = () => document.visibilityState;
const getServerDocumentVisibility = (): DocumentVisibilityState => "visible";

/** Tracks whether subscriptions should remain connected for the current tab. */
export function useDocumentVisibility(): DocumentVisibilityState {
  return useSyncExternalStore(
    subscribeToDocumentVisibility,
    getDocumentVisibility,
    getServerDocumentVisibility
  );
}

type AbortableTaskInput = {
  /** Restart the task when this value changes. */
  key: unknown;
  /** Skip the task while false. Defaults to true. */
  enabled?: boolean;
  /** Run work owned by the current component state. */
  run: (signal: AbortSignal) => Promise<void>;
  /** Handle a failure that did not come from cancellation. */
  onError: (error: unknown) => void;
};

/** Run one asynchronous task until its key changes or its owner unmounts. */
export function useAbortableTask(input: AbortableTaskInput): void {
  const run = useLatestEvent(input.run);
  const onError = useLatestEvent(input.onError);
  const enabled = input.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const controller = new AbortController();
    void run(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        onError(error);
      }
    });

    return () => controller.abort();
  }, [input.key, enabled, run, onError]);
}

/** Dispose an owned external operation when its component unmounts. */
export function useUnmountCleanup(cleanup: () => void): void {
  const onUnmount = useLatestEvent(cleanup);

  useEffect(() => () => onUnmount(), [onUnmount]);
}

type DomEventOptions = {
  /** Attach the listener only while this is true. Defaults to true. */
  enabled?: boolean;
  /** Listen during the capture phase, ahead of anything in the React tree. */
  capture?: boolean;
  /**
   * Attach on the next macrotask instead of during the commit. The interaction
   * that caused this hook to become enabled is often still being dispatched
   * while React commits, so a listener attached immediately would see that very
   * interaction. A "dismiss on outside click" listener attached during the
   * click that opened the thing would dismiss it again straight away.
   */
  deferAttach?: boolean;
};

/**
 * Subscribe to a `window` or `document` event for as long as the component is
 * mounted and `enabled`.
 */
export function useDomEvent<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: DomEventOptions
): void;
export function useDomEvent<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: DomEventOptions
): void;
export function useDomEvent(
  target: Window | Document,
  type: string,
  handler: (event: Event) => void,
  options?: DomEventOptions
): void {
  const enabled = options?.enabled ?? true;
  const capture = options?.capture ?? false;
  const deferAttach = options?.deferAttach ?? false;

  const onEvent = useLatestEvent((event: Event) => handler(event));

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const listener = (event: Event) => onEvent(event);

    if (!deferAttach) {
      target.addEventListener(type, listener, capture);
      return () => target.removeEventListener(type, listener, capture);
    }

    const attachTimer = setTimeout(() => {
      target.addEventListener(type, listener, capture);
    }, 0);

    return () => {
      clearTimeout(attachTimer);
      target.removeEventListener(type, listener, capture);
    };
  }, [target, type, enabled, capture, deferAttach, onEvent]);
}

/**
 * Run `run` right after the commit in which `key` changed, compared by
 * `Object.is`. For telling an imperative library or the raw DOM about something
 * React has just rendered: scrolling a newly selected item into view, or
 * handing React Flow a node whose handle set changed.
 *
 * The key is compared with `Object.is`, and a key going 0 to 1 and back to 0
 * runs three times: selecting the first item again should scroll to it again.
 */
export function useAfterCommit(key: unknown, run: () => void): void {
  const onKeyChanged = useLatestEvent(() => run());

  useEffect(() => {
    onKeyChanged();
  }, [key, onKeyChanged]);
}

/**
 * Like `useAfterCommit`, but before the browser paints the committed result.
 * Use this when an imperative layout correction must be visually atomic with
 * the React commit, such as keeping a React Flow node pinned while its graph is
 * replaced.
 */
export function useBeforePaint(key: unknown, run: () => void): void {
  const onKeyChanged = useLatestEvent(() => run());

  useLayoutEffect(() => {
    onKeyChanged();
  }, [key, onKeyChanged]);
}

/**
 * Like `useAfterCommit`, but on the next macrotask rather than during the
 * commit, cancelling a pending run if `key` changes again first.
 *
 * React Flow measures node dimensions after paint, so a viewport command issued
 * during the commit reads geometry that is one frame stale and fits the view to
 * the wrong box. Every canvas call site hand-rolled a `setTimeout(fn, 0)`
 * around its own; this is that timeout, named.
 */
export function useAfterPaint(key: unknown, run: () => void): void {
  const onKeyChanged = useLatestEvent(() => run());

  useEffect(() => {
    const timer = setTimeout(() => onKeyChanged(), 0);
    return () => clearTimeout(timer);
  }, [key, onKeyChanged]);
}

/**
 * Run `run` after `delayMs`, cancelling the pending run when `key` changes.
 * This is for a bounded fallback when an external measurement may never arrive,
 * not for sequencing ordinary UI state.
 */
export function useAfterDelay(
  key: unknown,
  delayMs: number,
  run: () => void
): void {
  const onDelay = useLatestEvent(() => run());

  useEffect(() => {
    const timer = setTimeout(() => onDelay(), delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs, onDelay]);
}

/**
 * `value`, but held back until it has stopped changing for `delayMs`.
 *
 * For a value that is cheap to read and expensive to answer questions about, on
 * a surface that changes it continuously. The workflow canvas rewrites its node
 * array on every frame of a drag, and the validation pass reading that array
 * cares about none of those frames: a position is not a config.
 *
 * This is a real synchronisation with time, which is why it is allowed here.
 * It is not a substitute for deriving a value in render -- the caller still does
 * that, one step behind.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

/**
 * Run `run` every `delayMs`. A `null` delay stops the interval.
 *
 * Not exported: a repeating fetch belongs in a query's `refetchInterval`, which
 * knows how to stop when the thing being polled reaches a terminal state and
 * how to avoid stacking requests. The one repeating thing here that is not a
 * fetch is the clock below.
 */
function useInterval(run: () => void, delayMs: number | null): void {
  const onTick = useLatestEvent(() => run());

  useEffect(() => {
    if (delayMs === null) {
      return undefined;
    }
    const interval = setInterval(() => onTick(), delayMs);
    return () => clearInterval(interval);
  }, [delayMs, onTick]);
}

/**
 * The current wall-clock time in milliseconds, re-rendering every `intervalMs`
 * while `enabled`. For a countdown that has to tick on screen even though
 * nothing in the app's state is changing.
 */
export function useNowMs(options: {
  intervalMs: number;
  enabled: boolean;
}): number {
  const { intervalMs, enabled } = options;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useInterval(() => setNowMs(Date.now()), enabled ? intervalMs : null);

  return nowMs;
}

/**
 * The pixel height of `ref`'s element, sampled after layout while `enabled`,
 * and 0 once it is not.
 *
 * A measurement of 0 while enabled means the element is not laid out yet, so
 * the last real height stands rather than the box collapsing to nothing
 * mid-transition. Turning `enabled` off clears it, so the next thing to open
 * grows from zero instead of from whatever was there before.
 *
 * Deliberately a sample rather than a live subscription: the overlay stack
 * renders the outgoing panel absolutely positioned while it slides away, so a
 * live measurement would always report the incoming panel's height and the
 * container would have no previous height to animate from.
 */
export function useMeasuredHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean
): number {
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (!enabled) {
      setHeight(0);
      return;
    }
    const measured = ref.current?.offsetHeight ?? 0;
    if (measured > 0) {
      setHeight(measured);
    }
  }, [ref, enabled]);

  return height;
}

/**
 * Whether an element's rendered content exceeds its box, kept current as the
 * content or box size changes. The callback ref measures the rendered element
 * rather than guessing from text length, which varies with font and zoom.
 */
export function useElementOverflow(input: { enabled: boolean; key: unknown }): {
  ref: RefCallback<HTMLElement>;
  overflowing: boolean;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  const ref = useCallback((next: HTMLElement | null) => {
    setElement(next);
  }, []);
  const measure = useCallback(() => {
    const next =
      input.enabled &&
      element !== null &&
      (element.scrollWidth > element.clientWidth ||
        element.scrollHeight > element.clientHeight);
    setOverflowing((current) => (current === next ? current : next));
  }, [element, input.enabled]);

  useLayoutEffect(() => {
    measure();
  }, [input.key, measure]);

  useLayoutEffect(() => {
    if (!(input.enabled && element) || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      const next =
        element.scrollWidth > element.clientWidth ||
        element.scrollHeight > element.clientHeight;
      setOverflowing((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, input.enabled]);

  return { ref, overflowing };
}

/** Focusable descendants, in tab order, skipping anything hidden or disabled. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
  );
}

/**
 * Hold keyboard focus inside `ref`'s element while `enabled`, and give it back
 * to whatever had it once the element goes away.
 *
 * The editor's overlays are a hand-rolled surface rather than a mounted popup,
 * so nothing was scoping Tab: focus walked out of the dialog and onto the canvas
 * behind the backdrop, where a keyboard user could act on controls they believed
 * were in front of them. This is the trap that surface never got.
 *
 * Not a substitute for the dialog role and `aria-modal`, which the container
 * sets; those tell a screen reader what the element is, and this decides where
 * Tab may go.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean
): void {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = enabled ? ref.current : null;
    if (root) {
      restoreTo.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      // Move focus in, so the first Tab lands inside rather than after the trap.
      if (!root.contains(document.activeElement)) {
        (focusableWithin(root)[0] ?? root).focus();
      }
    }

    return () => {
      restoreTo.current?.focus();
      restoreTo.current = null;
    };
  }, [ref, enabled]);

  const onKeyDown = useLatestEvent((event: KeyboardEvent) => {
    const root = ref.current;
    if (event.key !== "Tab" || !root) {
      return;
    }
    const items = focusableWithin(root);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items.at(-1);
    const active = document.activeElement;

    // Wrap at each end, and pull focus back in if it has already escaped.
    if (!root.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  useDomEvent(document, "keydown", onKeyDown, { enabled });
}
