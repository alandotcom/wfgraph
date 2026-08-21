import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
// The editor's React components for the built-in integrations: their icons and
// their custom output renderers. A component cannot be serialized, so this stays
// an import; everything else about an integration arrives over the wire, as the
// one catalog `hydrateExtensionsFromApi` below decodes.
import { integrationUi } from "@wfgraph/plugins/ui";
// Self-hosted variable fonts. The theme's --font-geist-sans/--font-geist-mono
// variables in globals.css point at the families these register.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "#src/routes/globals.css";
// The wfgraph Astryx theme's built tokens and component overrides. Imported
// after globals.css so vendor.css's @layer order statement is declared before
// this file's layer blocks land; regenerate with `pnpm run theme:build`.
import "#src/theme/wfgraph.css";
import {
  CatalogLoading,
  CatalogUnavailable,
} from "#src/components/catalog-boot";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { IntegrationUiProvider } from "#src/components/integration-ui-provider";
import { getBasePath } from "#src/lib/base-path";
import { queryClient } from "#src/lib/query-client";
import {
  getExtensionCatalog,
  hydrateExtensionsFromApi,
} from "#src/lib/extensions";
import { ThemeProvider } from "#src/theme/theme-provider";
import { router } from "./router";

declare global {
  interface Window {
    __resizeObserverPatched?: boolean;
  }
}

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

  return undefined;
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

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = createRoot(rootElement);

const renderApp = (children: ReactNode) => {
  root.render(<ThemeProvider>{children}</ThemeProvider>);
};

// Painted before the catalog request goes out, so the wait for it is a screen
// rather than a blank document. The editor draws nothing until it knows what a
// workflow can do, and a failed fetch takes the router's place: an editor drawn
// from a catalog that never arrived tells a builder their server declares no
// Events, which is a lie about somebody else's code.
renderApp(<CatalogLoading />);

const catalogLoad = await hydrateExtensionsFromApi();

renderApp(
  catalogLoad.ok ? (
    <ExtensionCatalogProvider value={getExtensionCatalog()}>
      <IntegrationUiProvider value={integrationUi}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </IntegrationUiProvider>
    </ExtensionCatalogProvider>
  ) : (
    <CatalogUnavailable
      endpoint={`${getBasePath()}/api/extensions`}
      reason={catalogLoad.reason}
    />
  )
);
