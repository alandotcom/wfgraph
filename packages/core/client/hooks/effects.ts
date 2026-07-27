import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
} from "react";

/**
 * The one file in packages/core/client allowed to import useEffect and
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
 * Every hook here takes its callback through `useEffectEvent`, so the callback
 * may be a fresh closure on every render and still not become a dependency of
 * the subscription it drives. Written as raw effects, these call sites had to
 * list their handler and the whole transitive tail of its `useCallback`
 * dependencies, and so tore down and rebuilt their timers and listeners on
 * renders that had nothing to do with the thing being synchronised.
 */

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

  const onEvent = useEffectEvent((event: Event) => handler(event));

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
  }, [target, type, enabled, capture, deferAttach]);
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
  const onKeyChanged = useEffectEvent(() => run());

  useEffect(() => {
    onKeyChanged();
  }, [key]);
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
  const onKeyChanged = useEffectEvent(() => run());

  useEffect(() => {
    const timer = setTimeout(() => onKeyChanged(), 0);
    return () => clearTimeout(timer);
  }, [key]);
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
  const onTick = useEffectEvent(() => run());

  useEffect(() => {
    if (delayMs === null) {
      return undefined;
    }
    const interval = setInterval(() => onTick(), delayMs);
    return () => clearInterval(interval);
  }, [delayMs]);
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
