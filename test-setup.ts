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

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
