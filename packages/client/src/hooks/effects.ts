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
import { insideKeyboardLayer } from "#src/lib/editor-shortcuts";
import { FOCUSABLE, focusOpener } from "#src/lib/focus-return";

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

/** How long a subscription the server closed waits before opening again. */
const SUBSCRIPTION_REOPEN_MS = 1_000;

/** Resolve after `ms`, or as soon as `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Own an async subscription and close it when its key changes or it unmounts.
 * A stream that ends on its own is opened again after a pause, so a mounted
 * subscription whose key has not changed is never left closed.
 * The input's type is written inline: TypeScript 7.1 infers `T` from
 * `subscribe` for an inline object type, and leaves `onValue`'s value
 * `unknown` when the same type is a named alias or interface.
 */
export function useAbortableSubscription<T>(input: {
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
}): void {
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
        while (!controller.signal.aborted) {
          // Each stream is opened only after the previous one ended.
          // eslint-disable-next-line no-await-in-loop
          const iterable = await subscribe(controller.signal);
          iterator = iterable[Symbol.asyncIterator]();
          if (controller.signal.aborted) {
            // eslint-disable-next-line no-await-in-loop
            await iterator.return?.();
            return;
          }

          while (!controller.signal.aborted) {
            // Async iterator reads are ordered and cannot run in parallel.
            // eslint-disable-next-line no-await-in-loop
            const result = await iterator.next();
            if (controller.signal.aborted) {
              return;
            }
            if (result.done) {
              break;
            }
            onValue(result.value);
          }

          // eslint-disable-next-line no-await-in-loop
          await abortableDelay(SUBSCRIPTION_REOPEN_MS, controller.signal);
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

/** The suffix every route's document title ends with. */
const APP_TITLE = "Workflow Graph";

/**
 * Name the browser tab and the history entry after the page on screen, as
 * `Workflows · Workflow Graph`. Each route calls this with its own place, so
 * the title holds whichever route rendered last and needs no restoring.
 */
export function useDocumentTitle(place: string): void {
  useEffect(() => {
    document.title = `${place} · ${APP_TITLE}`;
  }, [place]);
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
 * An element's layout size in CSS pixels, kept current as its content changes.
 * Layout size ignores a CSS `scale` or `transform` on the element, so a caller
 * can size a transform from it. Answers null while `enabled` is off, before
 * the element mounts, and where nothing lays it out, as in a test.
 */
export function useElementSize(enabled: boolean): {
  ref: RefCallback<HTMLElement>;
  size: { width: number; height: number } | null;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null
  );
  const ref = useCallback((next: HTMLElement | null) => {
    setElement(next);
  }, []);

  useLayoutEffect(() => {
    if (!(enabled && element)) {
      setSize(null);
      return undefined;
    }
    const measure = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize((current) =>
        width === 0 || height === 0
          ? null
          : current?.width === width && current.height === height
            ? current
            : { width, height }
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled]);

  return { ref, size };
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

/**
 * The focusable elements inside `root` a person can see. A subtree marked
 * `aria-hidden`, such as an overlay waiting behind the one on top of it, is
 * skipped along with anything that has no box.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      el.closest('[aria-hidden="true"]') === null &&
      (el.offsetWidth > 0 ||
        el.offsetHeight > 0 ||
        el === document.activeElement)
  );
}

/**
 * The control focus goes back to when a trap opened from `active` closes. A
 * menu item is gone by then, so a trap opened from one returns to the trigger
 * the menu names in `aria-labelledby`. Focus on the page body, or inside a menu
 * or the palette that names no trigger, gives no control that will still be
 * there, so the trap returns to the control the person last focused or pressed
 * outside them.
 */
function returnTarget(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement) || active === document.body) {
    return focusOpener();
  }
  const triggerId = active
    .closest('[role="menu"][aria-labelledby]')
    ?.getAttribute("aria-labelledby");
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  if (trigger) {
    return trigger;
  }
  return insideKeyboardLayer(active) ? focusOpener() : active;
}

/**
 * Hold keyboard focus inside `root` while `enabled`, and give it back to the
 * control that opened the trap once `enabled` turns false.
 *
 * The opener is read when `enabled` turns true, which may be a render before
 * `root` exists, since a portal mounts its children a commit late. Focus moves
 * in once `root` exists, to `initialFocus(root)` or else the first focusable
 * element. A menu that closes as the trap opens hands focus back to its
 * trigger, so focus arriving on the opener while the trap holds is sent back
 * in. A focused element inside `root`, such as an `autoFocus` field, keeps
 * focus.
 *
 * Not a substitute for the dialog role and `aria-modal`, which the caller
 * sets; those tell a screen reader what the element is, and this decides where
 * Tab may go.
 */
export function useFocusTrap(
  root: HTMLElement | null,
  enabled: boolean,
  options?: { initialFocus?: (root: HTMLElement) => HTMLElement | null }
): void {
  const restoreTo = useRef<HTMLElement | null>(null);
  const focusIn = useLatestEvent((element: HTMLElement) => {
    (
      options?.initialFocus?.(element) ??
      focusableWithin(element)[0] ??
      element
    ).focus({ preventScroll: true });
  });

  // Runs when the trap turns on and again when `root` arrives. The opener is
  // read on the first of those runs, before anything inside `root` has focus.
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    restoreTo.current ??= returnTarget(document.activeElement);
    if (root && !root.contains(document.activeElement)) {
      focusIn(root);
    }
    return undefined;
  }, [enabled, root, focusIn]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return () => {
      const target = restoreTo.current?.isConnected
        ? restoreTo.current
        : focusOpener();
      restoreTo.current = null;
      target?.focus({ preventScroll: true });
    };
  }, [enabled]);

  const onFocusIn = useLatestEvent((event: FocusEvent) => {
    if (root && event.target !== null && event.target === restoreTo.current) {
      focusIn(root);
    }
  });

  useDomEvent(document, "focusin", onFocusIn, {
    enabled: enabled && root !== null,
  });

  const onKeyDown = useLatestEvent((event: KeyboardEvent) => {
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
