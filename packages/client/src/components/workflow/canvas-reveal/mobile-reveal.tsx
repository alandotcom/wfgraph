import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import {
  type ConfirmRequest,
  type NodeConfigFrame,
  useNodeConfigTitle,
} from "#src/components/workflow/node-config-panel";
import { useAfterPaint } from "#src/hooks/effects";
import { nodesAtom, presentedGraphAtom } from "#src/lib/workflow-graph-store";
import {
  comparisonNodeTitle,
  scopeGroupLabel,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type {
  InspectedObject,
  OpenRevealLevel,
} from "#src/lib/workflow-navigation-state";
import { currentWorkflowNameAtom } from "#src/lib/workflow-save-store";
import {
  closeAllMobileSheetsAtom,
  closeMobileSheetAtom,
  openMobileInspectorOverAddressAtom,
  openMobileSheetAtom,
} from "#src/lib/mobile-sheet-store";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { cn } from "@wfgraph/shared/utils";
import {
  canvasRevealAtom,
  useShownMobileReveal,
  type MobileRevealState,
} from "./canvas-reveal-state";
import {
  MobileSheetHeader,
  type MobileSheetControls,
} from "./mobile-sheet-header";
import type { RevealHeaderModel } from "./reveal-header";
import { revealKind, type RevealKind } from "./reveal-kinds";
import { revealFieldRequestAtom } from "./reveal-requests";
import { useMobileSheetCamera } from "./use-mobile-sheet-camera";
import { useMobileSheetFocus } from "./use-mobile-sheet-focus";
import { useMobileSheetScroll } from "./use-mobile-sheet-scroll";
import { useRevealKeyboard } from "./use-reveal-keyboard";

/** The name a sheet goes by in the Back control of the sheet above it. */
function sheetTitle(
  inspected: InspectedObject | null,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string {
  if (inspected === null) {
    return "Summary";
  }
  if (inspected.kind === "edge") {
    return "Connection";
  }
  const node = nodes.find((item) => item.id === inspected.id);
  return node ? comparisonNodeTitle(node.data, catalog) : "Step";
}

/**
 * Where the Back control of a sheet whose kind has no `mobile` record leads, as
 * its visible label: the sheet beneath, or null for the first sheet.
 */
function draftBackLabel(
  state: MobileRevealState,
  nodes: readonly WorkflowNode[],
  catalog: ExtensionCatalog
): string | null {
  const { beneath, sheet } = state;
  if (beneath === null) {
    return null;
  }
  return beneath.inspected !== null &&
    sheet.inspected !== null &&
    beneath.inspected.kind === sheet.inspected.kind &&
    beneath.inspected.id === sheet.inspected.id
    ? "Summary"
    : sheetTitle(beneath.inspected, nodes, catalog);
}

/**
 * The title and status of a sheet whose kind has no `mobile` record. A kind
 * whose header the shell builds names them from its model; the one Draft kind
 * that builds its own header uses the node config panel's title.
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
 * The inspector below `md`, in every workspace: a sequence of sheets that the
 * navigation state records per scope. A summary sheet shows over the bottom of
 * the canvas, which stays pannable and zoomable above it, and an inspector
 * sheet covers the canvas. A sheet about an object shows the kind's Browse or
 * Focus body, and an address sheet shows the address itself, such as a run list
 * or a run. Back and Escape remove one sheet, restoring the sheet beneath with
 * its selection, scroll and camera, or answer through the kind's
 * `mobile.unwind`, as Runs does when Back leaves a run for its run list.
 */
export function MobileReveal() {
  const state = useShownMobileReveal();
  const { addressId: activeAddressId } = useAtomValue(canvasRevealAtom);
  const store = useStore();
  const navigate = useNavigate({ from: "/workflows/$workflowId" });
  const openSheet = useSetAtom(openMobileSheetAtom);
  const openInspectorOverAddress = useSetAtom(
    openMobileInspectorOverAddressAtom
  );
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
  const mobile = kind?.mobile;
  const shellOwnsScroll = mobile?.shellOwnsScroll ?? kind?.shellOwnsScroll;
  const heading = useSheetHeading(state, kind);
  const nodes = useAtomValue(nodesAtom);
  const presentedNodes = useAtomValue(presentedGraphAtom)?.nodes;
  const catalog = useExtensionCatalog();
  // The first sheet inside a focused Group leads back to that Group's canvas,
  // and its Back control is named for the Group in every workspace.
  const scopeBackLabel =
    state && state.beneath === null
      ? scopeGroupLabel(presentedNodes ?? [], state.address.scope)
      : null;
  const inspected = state?.sheet.inspected ?? null;
  const sheetKey = state?.sheetKey ?? null;

  // A kind that scrolls inside its own body keeps that scroll itself.
  const { ref, onScroll, onScrollEnd, adoptScroll, scrollToTop } =
    useMobileSheetScroll(
      state && shellOwnsScroll
        ? {
            address: state.address,
            sheetKey: state.sheetKey,
            depth: state.depth,
            level: state.level,
            inspected,
          }
        : null
    );

  const { onClickCapture, markBack } = useMobileSheetFocus({
    state,
    sheetKey,
    addressId: activeAddressId,
    fieldRequestPending: fieldRequest !== null,
    area: areaRef,
    sheet: sheetRef,
    title: titleRef,
    backFocusTarget: mobile?.backFocusTarget,
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
    if (state === null) {
      return;
    }
    markBack();
    const unwind = mobile?.unwind;
    if (!unwind) {
      closeSheet(state.address);
      return;
    }
    unwind({
      subject: state.subject,
      level: state.level === "inspector" ? "focus" : "browse",
      store,
      unwindLevel: () => closeSheet(state.address),
      // The sheet focus hook returns focus as sheets close.
      returnFocusOnClose: () => {},
      // Applying the route carries the sequence to the address it names.
      replaceRouteSearch: (search) => {
        void navigate({ search, replace: true });
      },
    });
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

  if (state === null || kind === null) {
    return null;
  }

  const isInspector = state.level === "inspector";
  const offersInspector =
    state.subject.levels.includes("focus") && kind.Focus !== null;
  const openInspector = (targetId?: string) => {
    const { subject, address } = state;
    if (!offersInspector) {
      return;
    }
    if (targetId !== undefined && subject.nodeId !== null) {
      setFieldRequest({ nodeId: subject.nodeId, targetId });
    }
    if (inspected !== null) {
      openSheet({ address, level: "inspector", inspected });
    } else if (subject.nodeId !== null) {
      // An address sheet opens the inspector of the node its address inspects.
      openInspectorOverAddress({
        address,
        inspected: { kind: "node", id: subject.nodeId },
      });
    }
  };
  const controls: MobileSheetControls = {
    back,
    openInspector:
      offersInspector && !isInspector ? () => openInspector() : null,
    titleRef,
    scopeBackLabel,
  };
  const level: OpenRevealLevel = isInspector ? "focus" : "browse";
  const Body =
    mobile?.Body ?? (isInspector && kind.Focus ? kind.Focus : kind.Browse);
  const body = (
    <Body
      frame={frame}
      key={state.subject.kind}
      level={level}
      mobile={state}
      openFocus={openInspector}
      scrollToTop={scrollToTop}
      subject={state.subject}
    />
  );

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
        {mobile ? (
          <mobile.Header controls={controls} key={kind.id} state={state} />
        ) : (
          <MobileSheetHeader
            backLabel={draftBackLabel(state, nodes, catalog)}
            controls={controls}
            inspectorLabel="Open editor"
            status={heading.status}
            title={heading.title}
          />
        )}
        {shellOwnsScroll ? (
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card"
            onScroll={onScroll}
            onScrollEnd={onScrollEnd}
            ref={ref}
          >
            {body}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col bg-card">{body}</div>
        )}
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
