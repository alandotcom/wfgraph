import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import "@/frontend/app/globals.css";
import { hydrateRuntimeExtensionsFromApi } from "@/client/lib/runtime-extensions";
import { router } from "./router";

if (process.env.NODE_ENV === "development") {
  import("react-grab");
}

const queryClient = new QueryClient();

const isResizeObserverLoopMessage = (message: string | undefined): boolean =>
  typeof message === "string" && message.includes("ResizeObserver loop");

const patchResizeObserver = () => {
  const state = window as unknown as { __resizeObserverPatched?: boolean };

  if (state.__resizeObserverPatched || !window.ResizeObserver) {
    return;
  }

  const NativeResizeObserver = window.ResizeObserver;

  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => callback(entries, observer));
      });
    }
  };

  state.__resizeObserverPatched = true;
};

const suppressResizeObserverLoopErrors = () => {
  window.addEventListener("error", (event) => {
    if (isResizeObserverLoopMessage(event.message)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    let message: string | undefined;

    if (typeof reason === "string") {
      message = reason;
    } else if (
      typeof reason === "object" &&
      reason !== null &&
      "message" in reason &&
      typeof (reason as { message?: unknown }).message === "string"
    ) {
      message = (reason as { message: string }).message;
    }

    if (isResizeObserverLoopMessage(message)) {
      event.preventDefault();
    }
  });
};

patchResizeObserver();
suppressResizeObserverLoopErrors();

await hydrateRuntimeExtensionsFromApi();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = createRoot(rootElement);

root.render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
