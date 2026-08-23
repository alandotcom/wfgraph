import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { OverlayProvider } from "#src/components/overlays/overlay-provider";
import { WorkflowSidebarPanel } from "#src/components/workflow/workflow-sidebar-panel";
import {
  canvasEditingLockedAtom,
  executionOverlayGraphAtom,
} from "#src/lib/workflow-graph-store";
import { isWorkflowOwnerAtom } from "#src/lib/workflow-save-store";
import { workflowPanelTab } from "#src/lib/workflow-route-state";
import {
  isSidebarCollapsedAtom,
  propertiesPanelActiveTabAtom,
  sidebarWidthCss,
  sidebarWidthPercentAtom,
} from "#src/lib/workflow-ui-store";
import {
  answerWorkflowRunRpc,
  extractRpcProcedurePath,
  parseRpcRequestInput,
  rpcUrl,
  type WorkflowRunRpcFixture,
} from "#src/lib/rpc-fetch-test-support";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const emptyCatalog: ExtensionCatalog = {
  events: [],
  actions: [],
  integrations: [],
};

/** What the run panel's procedures read. The tests here only open the tab. */
const served: WorkflowRunRpcFixture = {
  items: [],
  supersededCount: 0,
  graphs: {},
  logsSummaryExtras: {},
  logsByExecutionId: {},
  waitsByExecutionId: {},
};

/**
 * The Runs tab opens on a pinned run, so four oRPC procedures fire on render.
 * Without this the queries reach happy-dom's own origin and Node answers each
 * one with an unattributed ECONNRESET after the test has finished.
 */
function stubRunQueries(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = rpcUrl(input);
      const procedurePath = extractRpcProcedurePath(url);
      if (!procedurePath.startsWith("workflow/")) {
        throw new Error(`unexpected fetch in sidebar panel test: ${url}`);
      }

      return answerWorkflowRunRpc(
        served,
        procedurePath,
        await parseRpcRequestInput(init)
      );
    })
  );
}

function renderPanel() {
  const store = createStore();
  store.set(isWorkflowOwnerAtom, true);
  store.set(propertiesPanelActiveTabAtom, "runs");
  store.set(isSidebarCollapsedAtom, false);
  store.set(executionOverlayGraphAtom, {
    nodes: [
      {
        id: "v1_lifecycle",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: { label: "v1_lifecycle", type: "lifecycle" },
      },
    ],
    edges: [],
  });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$workflowId",
    validateSearch: (search: { executionId?: string } & SearchSchemaInput) => ({
      executionId:
        typeof search.executionId === "string" && search.executionId.length > 0
          ? search.executionId
          : undefined,
    }),
    beforeLoad: ({ search }) => {
      const tab = workflowPanelTab(search.executionId);
      if (tab !== null) {
        store.set(propertiesPanelActiveTabAtom, tab);
      }
    },
    component: () => <WorkflowSidebarPanel />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workflowRoute]),
    history: createMemoryHistory({
      initialEntries: ["/workflows/wf_1?executionId=exec_1"],
    }),
  });

  const view = render(
    <JotaiProvider store={store}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ExtensionCatalogProvider value={emptyCatalog}>
          <OverlayProvider>
            <RouterProvider router={router} />
          </OverlayProvider>
        </ExtensionCatalogProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );

  return { view, store, router };
}

/**
 * The inset the stylesheet actually declares, read from the file so that
 * renaming or removing the variable fails here rather than silently changing
 * what the panel is a share of. Two values are declared, the phone's zero and
 * the desktop's; this wants the desktop one.
 */
function declaredEditorInsetPx(): number {
  const css = readFileSync(
    join(import.meta.dirname, "../../routes/globals.css"),
    "utf8"
  );
  const declared = [...css.matchAll(/--editor-inset:\s*([\d.]+)px/g)].map(
    (match) => Number(match[1])
  );
  if (declared.length === 0) {
    throw new Error("globals.css declares no --editor-inset");
  }
  return Math.max(...declared);
}

/**
 * What a browser resolves one of `sidebarWidthCss`'s expressions to: enough of
 * `var()`, `calc()`, `min()` and `max()` for that one string.
 *
 * The test needs the width the panel renders, and the point of it is that the
 * rendered width and the drag agree about which rectangle they are a share of.
 * Reading the expression is the only way to ask that question without a
 * browser: recomputing the width from the percentage would be repeating the
 * arithmetic the drag just did, and would pass whichever rectangle either side
 * chose.
 */
function resolveCssWidthPx(
  css: string,
  viewport: { width: number; insetPx: number }
): number {
  const tokens = css
    .replace(/var\(--editor-inset,\s*0px\)/g, String(viewport.insetPx))
    .replace(
      /([\d.]+)vw/g,
      (_, share: string) => `${(viewport.width * Number(share)) / 100}`
    )
    .replace(/([\d.]+)px/g, "$1")
    .match(/min|max|calc|[(),]|[-+*/]|[\d.]+/g);

  if (!tokens) {
    throw new Error(`no width expression in ${css}`);
  }

  let at = 0;
  const take = (expected?: string): string => {
    const token = tokens[at];
    at += 1;
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected} at ${at} of ${css}`);
    }
    return token;
  };

  const expression = (): number => {
    let value = term();
    while (tokens[at] === "+" || tokens[at] === "-") {
      const operator = take();
      value = operator === "+" ? value + term() : value - term();
    }
    return value;
  };

  const term = (): number => {
    let value = factor();
    while (tokens[at] === "*" || tokens[at] === "/") {
      const operator = take();
      value = operator === "*" ? value * factor() : value / factor();
    }
    return value;
  };

  const factor = (): number => {
    const token = take();
    if (token === "(" || token === "calc") {
      if (token === "calc") {
        take("(");
      }
      const value = expression();
      take(")");
      return value;
    }
    if (token === "min" || token === "max") {
      take("(");
      const first = expression();
      take(",");
      const second = expression();
      take(")");
      return token === "min"
        ? Math.min(first, second)
        : Math.max(first, second);
    }
    return Number(token);
  };

  const width = expression();
  if (at !== tokens.length) {
    throw new Error(`unread tokens in ${css}`);
  }
  return width;
}

/** The viewport happy-dom answers a media query from. */
function setViewportWidth(width: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number }) => void };
    }
  ).happyDOM.setViewport({ width });
}

describe("WorkflowSidebarPanel", () => {
  beforeEach(() => {
    stubRunQueries();
    // The window is shared across every file in this worker, and the rail is
    // desktop-only, so the width it renders at is stated here rather than
    // inherited from whichever test ran last.
    setViewportWidth(1280);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The suite runs with `isolate: false`, so a variable left on the document
    // is still there for the next file in this worker.
    document.documentElement.style.removeProperty("--editor-inset");
  });

  // Collapsing slides the rail behind the viewport edge without unmounting it,
  // so the Runs tab kept its state while its tab bar was out of reach: the run
  // stayed pinned to the canvas and every edit was refused with nothing on
  // screen saying why. Same shape as the mobile sheet in #96.
  it("closes the open run when the rail is collapsed", async () => {
    const { view, store, router } = renderPanel();

    await waitFor(() => {
      expect(view.getByLabelText("Collapse panel")).toBeTruthy();
    });
    expect(store.get(canvasEditingLockedAtom)).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByLabelText("Collapse panel"));
    });

    expect(store.get(isSidebarCollapsedAtom)).toBe(true);
    expect(store.get(propertiesPanelActiveTabAtom)).toBe("properties");
    expect(router.state.location.search).toEqual({});
    expect(store.get(canvasEditingLockedAtom)).toBe(false);
  });

  // Cmd+B is the other way to collapse, and a shortcut that skipped the exit
  // would leave the same locked canvas the button no longer can.
  it("closes the open run when the collapse shortcut is pressed", async () => {
    const { view, store, router } = renderPanel();

    await waitFor(() => {
      expect(view.getByLabelText("Collapse panel")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });

    expect(store.get(isSidebarCollapsedAtom)).toBe(true);
    expect(store.get(propertiesPanelActiveTabAtom)).toBe("properties");
    expect(router.state.location.search).toEqual({});
  });

  // The percentage the drag stores is a share of the editor shell, which is the
  // viewport less its inset on each side, and `sidebarWidthCss` has to say the
  // same thing for the released edge to land under the pointer. A drag measured
  // against `window.innerWidth` agreed with it only while the shell was the
  // whole viewport; inset, it put the edge an inset away, which nothing but a
  // ruler on screen would have reported.
  //
  // Both clamps are in here too, because the edge follows the pointer only
  // between them: `sidebarWidthCss` holds the rendered width to 320-460px, so
  // outside that band the panel stops where the clamp puts it however far the
  // pointer goes.
  it.each([
    { name: "inside the band", dragTo: 370, renders: 370 },
    { name: "past the cap", dragTo: 520, renders: 460 },
    { name: "under the floor", dragTo: 260, renders: 320 },
  ])(
    "a resize released $dragTo px from the shell's edge renders $renders px ($name)",
    async ({ dragTo, renders }) => {
      const { view, store } = renderPanel();

      await waitFor(() => {
        expect(view.getByLabelText("Collapse panel")).toBeTruthy();
      });

      const insetPx = declaredEditorInsetPx();
      document.documentElement.style.setProperty(
        "--editor-inset",
        `${insetPx}px`
      );

      const panelRight = window.innerWidth - insetPx;
      const column = document.querySelector(
        ".workflow-sidebar-panel"
      )?.parentElement;
      if (!column) {
        throw new Error("the panel column did not render");
      }
      // happy-dom lays nothing out, so the one measurement the drag takes is
      // given an answer: the inner edge of the shell, where the column ends.
      column.getBoundingClientRect = () => ({ right: panelRight }) as DOMRect;

      const releasedAt = panelRight - dragTo;
      const separator = view.getByLabelText(
        "Resize properties panel. Click to collapse."
      );

      await act(async () => {
        // Away from the release point, so this is a drag rather than the click
        // that collapses the panel.
        fireEvent.pointerDown(separator, { clientX: panelRight - 300 });
        fireEvent.pointerMove(document, { clientX: releasedAt });
        fireEvent.pointerUp(document, { clientX: releasedAt });
      });

      const renderedWidth = resolveCssWidthPx(
        sidebarWidthCss(store.get(sidebarWidthPercentAtom)),
        { width: window.innerWidth, insetPx }
      );
      expect(renderedWidth).toBeCloseTo(renders, 6);
    }
  );

  // Expanding is not an exit. The same handler runs, and reading the collapse
  // flag the wrong way round would close a run every time the rail came back.
  it("keeps the run when the rail is expanded again", async () => {
    const { view, store, router } = renderPanel();

    await waitFor(() => {
      expect(view.getByLabelText("Collapse panel")).toBeTruthy();
    });

    // Inside act, so the rail has re-rendered against the collapsed value
    // before the shortcut reads it. Set outside, the handler would still hold
    // the expanded value and the keypress would collapse a second time.
    await act(async () => {
      store.set(isSidebarCollapsedAtom, true);
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });

    expect(store.get(isSidebarCollapsedAtom)).toBe(false);
    expect(store.get(propertiesPanelActiveTabAtom)).toBe("runs");
    expect(router.state.location.search).toEqual({ executionId: "exec_1" });
  });
});
