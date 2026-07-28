import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";

// happy-dom overwrites these two with its own versions, and its TransformStream
// is a stub whose `writable` is a boolean rather than a stream. Bun implements
// both correctly, and this preload applies to the whole suite, so a backend test
// that never touches the DOM would otherwise inherit the broken pair. Inngest's
// execution engine builds a TransformStream for SSE on every run, which is where
// this last surfaced.
const nativeTransformStream = globalThis.TransformStream;
const nativeWritableStream = globalThis.WritableStream;

GlobalRegistrator.register({
  url: "http://localhost:3000",
});

globalThis.TransformStream = nativeTransformStream;
globalThis.WritableStream = nativeWritableStream;

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

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16);
}

if (!globalThis.cancelAnimationFrame) {
  globalThis.cancelAnimationFrame = (id: number) => {
    clearTimeout(id);
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
