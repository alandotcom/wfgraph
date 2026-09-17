import { useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, Maximize2, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { Button } from "#src/components/ui/button";
import {
  type ConfirmRequest,
  type NodeConfigFrame,
  useNodeConfigTitle,
} from "#src/components/workflow/node-config-panel";
import { statusToneTextClass } from "#src/components/workflow/workflow-run-shared";
import { useAfterPaint } from "#src/hooks/effects";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import {
  comparisonNodeTitle,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { InspectedObject } from "#src/lib/workflow-navigation-state";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import {
  closeAllMobileSheetsAtom,
  closeMobileSheetAtom,
  openMobileSheetAtom,
} from "#src/lib/workflow-workspace-navigation";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { cn } from "@wfgraph/shared/utils";
import {
  useShownMobileReveal,
  type MobileRevealState,
} from "./canvas-reveal-state";
import type { RevealHeaderModel } from "./reveal-header";
import { revealKind, type RevealKind } from "./reveal-kinds";
import { revealFieldRequestAtom } from "./reveal-requests";
import { useMobileSheetCamera } from "./use-mobile-sheet-camera";
import { useMobileSheetFocus } from "./use-mobile-sheet-focus";
import { useMobileSheetScroll } from "./use-mobile-sheet-scroll";
import { useRevealKeyboard } from "./use-reveal-keyboard";

/** The name a sheet goes by in the Back control of the sheet above it. */
function sheetTitle(
  inspected: InspectedObject,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string {
  if (inspected.kind === "edge") {
    return "Connection";
  }
  const node = nodes.find((item) => item.id === inspected.id);
  return node ? comparisonNodeTitle(node.data, catalog) : "Step";
}

/** Where the Back control of the shown sheet leads, as its visible label. */
function backLabel(
  state: MobileRevealState,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string | null {
  const { beneath, sheet } = state;
  if (beneath === null) {
    return null;
  }
  return beneath.inspected.kind === sheet.inspected.kind &&
    beneath.inspected.id === sheet.inspected.id
    ? "Summary"
    : sheetTitle(beneath.inspected, nodes, catalog);
}

/**
 * The title and status of a kind whose header the shell builds from a model,
 * or the node config panel's own title for the one Draft kind that builds its
 * own header.
 */
function useSheetHeading(
  state: MobileRevealState | null,
  kind: RevealKind | null
): Pick<RevealHeaderModel, "title" | "status"> {
  const nodes = useAtomValue(nodesAtom);
  const issues = useAtomValue(workflowIssuesAtom);
  const workflowName = useAtomValue(currentWorkflowNameAtom);
  const catalog = useExtensionCatalog();
  const panelTitle = useNodeConfigTitle();
  if (state === null || kind === null || kind.header.owner === "kind") {
    return { title: panelTitle, status: null };
  }
  const model = kind.header.model(state.subject, {
    nodes,
    issues,
    workflowName,
    catalog,
  });
  return { title: model.title, status: model.status };
}

/**
 * The Draft inspector below `md`: a sequence of sheets that the navigation
 * state records per scope. A summary sheet shows a kind's Browse body over the
 * bottom of the canvas, which stays pannable and zoomable above it; the
 * inspector shows the kind's Focus body over the whole canvas. Back and Escape
 * remove one sheet, restoring the sheet beneath with its selection, scroll and
 * camera. Runs and Changes keep the configuration sheet.
 */
export function MobileReveal() {
  const state = useShownMobileReveal();
  const nodes = useAtomValue(nodesAtom);
  const catalog = useExtensionCatalog();
  const openSheet = useSetAtom(openMobileSheetAtom);
  const closeSheet = useSetAtom(closeMobileSheetAtom);
  const closeAllSheets = useSetAtom(closeAllMobileSheetsAtom);
  const fieldRequest = useAtomValue(revealFieldRequestAtom);
  const setFieldRequest = useSetAtom(revealFieldRequestAtom);
  const { hasOverlays } = useOverlay();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const frame = useMemo<NodeConfigFrame>(() => ({ confirm: setRequest }), []);
  const areaRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const kind = state ? revealKind(state.subject) : null;
  const heading = useSheetHeading(state, kind);
  const inspected = state?.sheet.inspected ?? null;
  const sheetKey = state
    ? `${state.addressId}|${state.depth}|${state.level}|${state.sheet.inspected.kind}:${state.sheet.inspected.id}`
    : null;

  const { ref, onScroll, onScrollEnd, adoptScroll, scrollToTop } =
    useMobileSheetScroll(
      state && inspected
        ? {
            address: state.address,
            addressId: state.addressId,
            depth: state.depth,
            level: state.level,
            inspected,
          }
        : null
    );

  const { onClickCapture } = useMobileSheetFocus({
    state,
    sheetKey,
    fieldRequestPending: fieldRequest !== null,
    area: areaRef,
    sheet: sheetRef,
    title: titleRef,
  });
  useMobileSheetCamera({ state, sheet: sheetRef });

  // A field request is answered once its step shows the inspector, or its
  // summary when the step offers no inspector.
  useAfterPaint(
    `${fieldRequest?.nodeId ?? ""}|${fieldRequest?.targetId ?? ""}|${sheetKey ?? ""}`,
    () => {
      if (
        fieldRequest === null ||
        state === null ||
        state.subject.nodeId !== fieldRequest.nodeId ||
        (state.level !== "inspector" && state.subject.levels.includes("focus"))
      ) {
        return;
      }
      setFieldRequest(null);
      const element = document.getElementById(fieldRequest.targetId);
      element?.focus();
      element?.scrollIntoView?.({ block: "center" });
      adoptScroll();
    }
  );

  const back = () => {
    if (state) {
      closeSheet(state.address);
    }
  };

  useRevealKeyboard({
    enabled: state !== null,
    level: state ? "browse" : "closed",
    hasOverlays,
    area: areaRef,
    onToggle: () => {
      if (state) {
        closeAllSheets(state.address);
      }
    },
    onUnwind: back,
  });

  if (state === null || kind === null || inspected === null) {
    return null;
  }

  const offersInspector =
    state.subject.levels.includes("focus") && kind.Focus !== null;
  const openInspector = (targetId?: string) => {
    if (!offersInspector) {
      return;
    }
    if (targetId !== undefined && state.subject.nodeId !== null) {
      setFieldRequest({ nodeId: state.subject.nodeId, targetId });
    }
    openSheet({ address: state.address, level: "inspector", inspected });
  };
  const isInspector = state.level === "inspector";
  const Body = isInspector && kind.Focus ? kind.Focus : kind.Browse;
  const beneathLabel = backLabel(state, nodes, catalog);

  return (
    <>
      <section
        aria-label={kind.regionLabel}
        className={cn(
          // `nokey` keeps React Flow's Backspace and Delete handling away from
          // the selected step while focus is on a control inside the sheet.
          "mobile-reveal nokey absolute z-20 flex flex-col overflow-hidden bg-card",
          "pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]",
          isInspector
            ? "inset-0"
            : "inset-x-0 bottom-0 max-h-[min(60%,28rem)] rounded-t-xl border-t shadow-lg"
        )}
        data-level={state.level}
        data-slot="mobile-reveal"
        onClickCapture={onClickCapture}
        ref={(element) => {
          sheetRef.current = element;
          // Kept after the sheet unmounts, so closing can return focus there.
          if (element) {
            areaRef.current = element.parentElement;
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          {beneathLabel === null ? null : (
            <Button
              aria-label={`Back to ${beneathLabel}`}
              className="h-11 max-w-[40%] shrink-0 px-2"
              onClick={back}
              type="button"
              variant="ghost"
            >
              <ChevronLeft className="size-4" />
              <span className="truncate">{beneathLabel}</span>
            </Button>
          )}
          <div className="min-w-0 flex-1 px-2">
            <h2
              className="truncate font-semibold text-sm outline-none"
              data-slot="reveal-title"
              ref={titleRef}
              tabIndex={-1}
            >
              {heading.title}
            </h2>
            {heading.status ? (
              <p
                className={cn(
                  "truncate text-xs",
                  statusToneTextClass(heading.status.tone)
                )}
              >
                {heading.status.text}
              </p>
            ) : null}
          </div>
          {!isInspector && offersInspector ? (
            <Button
              className="h-11 shrink-0 px-3"
              onClick={() => openInspector()}
              type="button"
              variant="outline"
            >
              <Maximize2 className="size-4" />
              Open editor
            </Button>
          ) : null}
          {beneathLabel === null ? (
            <Button
              aria-label="Close"
              className="size-11 shrink-0"
              onClick={back}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card"
          onScroll={onScroll}
          onScrollEnd={onScrollEnd}
          ref={ref}
        >
          <Body
            frame={frame}
            key={state.subject.kind}
            level={isInspector ? "focus" : "browse"}
            openFocus={openInspector}
            scrollToTop={scrollToTop}
            subject={state.subject}
          />
        </div>
      </section>
      <DeleteConfirmDialog
        confirmLabel={request?.confirmLabel}
        description={request?.message}
        onConfirm={() => request?.onConfirm()}
        onOpenChange={(open) => {
          if (!open) {
            setRequest(null);
          }
        }}
        open={request !== null}
        title={request?.title}
      />
    </>
  );
}

/**
 * The canvas and the agent panel beneath the mobile Reveal sequence. While the
 * full-screen inspector covers them, both leave keyboard and screen reader
 * navigation. `contents` keeps the wrapper out of the layout.
 */
export function MobileRevealCovered({ children }: { children: ReactNode }) {
  const covered = useShownMobileReveal()?.level === "inspector";
  return (
    <div className="contents" data-slot="mobile-reveal-covered" inert={covered}>
      {children}
    </div>
  );
}
