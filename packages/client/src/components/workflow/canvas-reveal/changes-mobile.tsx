/**
 * The Changes sheets on a phone: the comparison summary, the change list, and
 * version history as address sheets, and one object's field differences as its
 * inspector. Every sheet reads only the comparison the route names, so while
 * another comparison loads it shows that state instead.
 */

import { useAtomValue, useSetAtom } from "jotai";
import { History, ListChecks, RefreshCw, X } from "lucide-react";
import { useMemo } from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import { StatusPlaceholder } from "#src/components/workflow/status-placeholder";
import { useWorkflowComparisonActions } from "#src/components/workflow/use-workflow-comparison-actions";
import { WorkflowVersionHistory } from "#src/components/workflow/workflow-version-history";
import { useWorkflowWorkspaceNavigation } from "#src/hooks/use-workflow-workspace-navigation";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import type { WorkspaceAddress } from "#src/lib/workflow-navigation-state";
import {
  closeMobileSheetAtom,
  openMobileAddressSectionAtom,
} from "#src/lib/mobile-sheet-store";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { RevealBodyProps } from "./reveal-kinds";
import {
  ChangeListSections,
  ComparisonState,
  ComparisonSummarySection,
} from "./changes-browse";
import { ChangeFieldDifferences } from "./changes-focus";
import { useChangedObjects, useOpenMobileChange } from "./changes-navigation";
import {
  CHANGE_LIST_SECTION,
  changesMobileHeading,
  changesMobileSheet,
  changesMobileSheetName,
  comparisonRevealContextAtom,
  inspectChange,
  noChangesLabel,
  VERSION_HISTORY_SECTION,
  type ChangeInspection,
} from "./changes-summary";
import { MobileSheetHeader } from "./mobile-sheet-header";
import type { MobileKindHeaderProps } from "./reveal-kinds";

/**
 * The header of the Changes sheet on screen. Back is named for the sheet
 * beneath. The field differences are the deepest sheet, so no sheet names an
 * inspector control.
 */
export function ChangesMobileHeader({
  state,
  controls,
}: MobileKindHeaderProps) {
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const graph = useAtomValue(comparisonDisplayGraphAtom);
  const catalog = useExtensionCatalog();
  const payload = "payload" in comparison ? comparison.payload : null;
  const objectKind = state.sheet.inspected?.kind;
  const objectId = state.sheet.inspected?.id;
  const inspection = useMemo(
    (): ChangeInspection =>
      payload && graph && objectKind !== undefined && objectId !== undefined
        ? inspectChange({
            payload,
            graph,
            catalog,
            objects: [],
            object: { kind: objectKind, id: objectId },
          })
        : { kind: "unavailable" },
    [catalog, graph, objectId, objectKind, payload]
  );
  const heading = changesMobileHeading({
    comparison,
    sheet: changesMobileSheet(state.sheet),
    inspection,
  });
  return (
    <MobileSheetHeader
      backLabel={
        state.beneath === null
          ? null
          : changesMobileSheetName(changesMobileSheet(state.beneath))
      }
      controls={controls}
      status={heading.status}
      title={heading.title}
    />
  );
}

/** The body of the Changes sheet on screen, chosen by which sheet it is. */
export function ChangesMobileBody({ mobile: state }: RevealBodyProps) {
  const actions = useWorkflowComparisonActions();
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const closeSheet = useSetAtom(closeMobileSheetAtom);
  if (state === null) {
    return null;
  }
  const sheet = changesMobileSheet(state.sheet);
  if (sheet === "change") {
    return <ChangeFieldDifferences />;
  }
  if (!("payload" in comparison)) {
    return (
      <>
        <ComparisonState
          actions={actions}
          address={state.address}
          status={comparison.status}
        />
        {sheet === "summary" ? (
          <ComparisonCommands actions={actions} address={state.address} />
        ) : null}
      </>
    );
  }
  if (sheet === "history") {
    // Choosing a version removes the history sheet, so this comparison keeps
    // its summary sheet and the chosen comparison opens a summary sheet of its
    // own when its route applies.
    return (
      <WorkflowVersionHistory
        actions={actions}
        onChooseBase={() => closeSheet(state.address)}
      />
    );
  }
  if (sheet === "changes") {
    return <ChangeListSheet payload={comparison.payload} />;
  }
  return (
    <div data-testid="workflow-changes">
      <ComparisonSummarySection
        payload={comparison.payload}
        status={comparison.status}
      />
      <ChangeListEntry address={state.address} payload={comparison.payload} />
      <ComparisonCommands actions={actions} address={state.address} />
    </div>
  );
}

/**
 * The control that opens the change list, naming how many objects changed,
 * or the sentence that says nothing changed.
 */
function ChangeListEntry({
  address,
  payload,
}: {
  address: WorkspaceAddress;
  payload: WorkflowComparisonPayload;
}) {
  const { objects } = useChangedObjects(payload);
  const openSection = useSetAtom(openMobileAddressSectionAtom);
  if (objects.length === 0) {
    return (
      <p className="px-4 py-3 text-muted-foreground text-sm">
        {noChangesLabel(payload)}
      </p>
    );
  }
  const count = objects.length;
  return (
    <div className="px-4 py-3">
      <Button
        className="w-full"
        onClick={() =>
          openSection({
            address,
            level: "summary",
            section: CHANGE_LIST_SECTION,
          })
        }
        type="button"
        variant="default"
      >
        <ListChecks data-icon="inline-start" />
        Review {count} {count === 1 ? "change" : "changes"}
      </Button>
    </div>
  );
}

/**
 * Refresh comparison, Version history, and Exit comparison. Refresh and
 * Version history wait for a comparison to be shown and for its request to
 * settle.
 */
function ComparisonCommands({
  actions,
  address,
}: {
  actions: ReturnType<typeof useWorkflowComparisonActions>;
  address: WorkspaceAddress;
}) {
  const comparison = useAtomValue(comparisonRevealContextAtom);
  const openSection = useSetAtom(openMobileAddressSectionAtom);
  const { showDraft } = useWorkflowWorkspaceNavigation();
  const unavailable = !("payload" in comparison) || actions.isPending;
  return (
    <div className="flex flex-wrap gap-2 border-t px-4 py-3">
      <Button
        disabled={unavailable || !actions.canCompare}
        onClick={() => void actions.openComparison({ force: true })}
        type="button"
        variant="outline"
      >
        <RefreshCw data-icon="inline-start" />
        Refresh comparison
      </Button>
      <Button
        disabled={unavailable}
        onClick={() =>
          openSection({
            address,
            level: "inspector",
            section: VERSION_HISTORY_SECTION,
          })
        }
        type="button"
        variant="outline"
      >
        <History data-icon="inline-start" />
        Version history
      </Button>
      <Button onClick={showDraft} type="button" variant="ghost">
        <X data-icon="inline-start" />
        Exit comparison
      </Button>
    </div>
  );
}

/**
 * The change list as a sheet. Choosing a row shows that object's field
 * differences in a sheet over the list, which keeps its scroll for Back.
 */
function ChangeListSheet({ payload }: { payload: WorkflowComparisonPayload }) {
  const { objects, selectedKey } = useChangedObjects(payload);
  const openChange = useOpenMobileChange();
  if (objects.length === 0) {
    return <StatusPlaceholder label={noChangesLabel(payload)} />;
  }
  return (
    <div data-slot="change-list">
      <ChangeListSections
        objects={objects}
        onChoose={openChange}
        selectedKey={selectedKey}
      />
    </div>
  );
}
