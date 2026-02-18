import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import "@/frontend/app/globals.css";
import { hydrateRuntimeExtensionsFromApi } from "@/client/lib/runtime-extensions";
import { router } from "./router";

declare global {
  interface Window {
    __resizeObserverPatched?: boolean;
  }
}

if (process.env.NODE_ENV === "development") {
  import("react-grab");
}

const queryClient = new QueryClient();

const isResizeObserverLoopMessage = (message: string | undefined): boolean =>
  typeof message === "string" && message.includes("ResizeObserver loop");

function getErrorMessage(reason: unknown): string | undefined {
  if (typeof reason === "string") {
    return reason;
  }

  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string"
  ) {
    return reason.message;
  }

  return;
}

const patchResizeObserver = () => {
  if (window.__resizeObserverPatched || !window.ResizeObserver) {
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

  window.__resizeObserverPatched = true;
};

const suppressResizeObserverLoopErrors = () => {
  window.addEventListener("error", (event) => {
    if (isResizeObserverLoopMessage(event.message)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const message = getErrorMessage(event.reason);

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
