import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Setup for the client project only; the backend packages run in vitest's node
// environment and never see any of this. happy-dom provides the document, and
// what follows fills the gaps the client's components reach for during a
// render. Each shim is guarded, so a happy-dom release that grows its own
// implementation takes over without a change here.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (!globalThis.ResizeObserver) {
  class ResizeObserverMock {
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  }

  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
}

// window.setTimeout rather than the bare global, because the DOM one answers a
// number and node's answers a Timeout object, and a frame handle is a number.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16);
}

if (!globalThis.cancelAnimationFrame) {
  globalThis.cancelAnimationFrame = (id: number) => {
    window.clearTimeout(id);
  };
}

// happy-dom 20.12 grew `Element.animate()` and the WAAPI `Animation` class,
// which is enough for motion to take its native animation path here rather than
// its JavaScript one. That class builds its `finished` promise in the
// constructor and rejects it inside `cancel()`. A browser marks that rejection
// handled when nothing is awaiting the promise; happy-dom does not, so
// unmounting a component mid-animation reaches node as an unhandled AbortError
// and fails the run around a passing test. Attaching a no-op handler to each
// `finished` promise settles that without hiding anything: the property still
// answers the same promise, so a caller that awaits it still sees the
// rejection.
// oxlint-disable-next-line typescript/unbound-method -- the receiver is not lost: every call below reaches the original through `apply` with the element it was called on.
const nativeAnimate = Element.prototype.animate;
if (nativeAnimate) {
  Element.prototype.animate = function animateWithSettledFinished(
    this: Element,
    ...args: Parameters<Element["animate"]>
  ): Animation {
    const animation = nativeAnimate.apply(this, args);
    let finished = animation.finished;
    finished.catch(() => undefined);

    Object.defineProperty(animation, "finished", {
      configurable: true,
      get: () => finished,
      // `play()` builds a fresh promise after a cancel, so each one in turn
      // needs its own handler.
      set: (next: Promise<Animation>) => {
        finished = next;
        next.catch(() => undefined);
      },
    });

    return animation;
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
