/**
 * The subject kinds Canvas Reveal can show, one record each: `header` builds the
 * header, `unwind` answers Back and Escape, `mobile` adapts the sheets below `md`,
 * and `shellOwnsScroll` names the body's scroller. The shell keys the body by kind,
 * so one component registered as both `Browse` and `Focus` stays mounted.
 */

import type { ComponentType } from "react";
import type { NodeConfigFrame } from "#src/components/workflow/node-config-panel";
import {
  NodeConfigPanel,
  useNodeConfigTitle,
} from "#src/components/workflow/node-config-panel";
import { NodePropertiesForm } from "#src/components/workflow/node-properties-form";
import { setComparisonSubviewAtom } from "#src/lib/workflow-comparison-store";
import { groupLabel, type WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  workspaceAddressId,
  type OpenRevealLevel,
  type WorkflowRouteSearch,
} from "#src/lib/workflow-navigation-state";
import { groupIssues } from "#src/lib/workflow-issues-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { isBlank } from "@wfgraph/shared/types/string";
import { compact } from "es-toolkit/array";
import type { createStore, Getter } from "jotai";
import { activeChosenExecutionAtom } from "#src/lib/workflow-workspace-navigation";
import { ChangesBrowse, ChangesHeader } from "./changes-browse";
import { ChangesFocus } from "./changes-focus";
import { ChangesMobileBody, ChangesMobileHeader } from "./changes-mobile";
import {
  changeRowFocusRequestAtom,
  comparisonRevealContextAtom,
} from "./changes-summary";
import { ConditionBrowse, ConditionFocus } from "./condition-reveal";
import { EventSplitBrowse } from "./event-split-reveal";
import { GroupBrowse, GroupFocusSections } from "./group-browse";
import { LifecycleBrowse } from "./lifecycle-browse";
import { LifecycleFocus } from "./lifecycle-focus";
import type { MobileRevealState } from "./canvas-reveal-state";
import type { MobileSheetControls } from "./mobile-sheet-header";
import type { RevealFocusWidth } from "./reveal-geometry";
import {
  RevealHeader,
  type RevealHeaderControls,
  type RevealHeaderModel,
} from "./reveal-header";
import {
  matchChangesSubject,
  matchConditionSubject,
  matchEventSplitSubject,
  matchGroupSubject,
  matchLifecycleSubject,
  matchPanelSubject,
  matchRunsSubject,
  matchStepSubject,
  type RevealKindId,
  type RevealMatchInput,
  type RevealSubject,
} from "./reveal-subject";
import { unwindToInspectedOrigin } from "./reveal-origin";
import {
  RunsBody,
  RunsHeader,
  RunsMobileHeader,
  unwindRuns,
} from "./runs-browse";
import { StepBrowse } from "./step-browse";

export type RevealBodyProps = {
  subject: RevealSubject;
  /**
   * The level the body is shown at. A kind that names one component for both
   * Browse and Focus reads it, and that component stays mounted between them.
   */
  level: OpenRevealLevel;
  frame: NodeConfigFrame;
  /**
   * Show Focus, then focus the element whose id is `targetId`: a field's
   * config key, or the `headingId` of a section.
   */
  openFocus: (targetId?: string) => void;
  /**
   * Scroll the body to its top without recording a scroll, for a body that
   * replaces what it shows after a navigation write already reset its scroll.
   */
  scrollToTop: () => void;
  /**
   * The mobile Reveal sheet the body shows on below `md`, or null when desktop
   * Canvas Reveal shows it. The shell passes it so a body reads the sheet
   * without importing the state module, which imports every kind.
   */
  mobile: MobileRevealState | null;
};

/** The graph state the shell reads for a header it builds from a model. */
export type RevealHeaderContext = {
  nodes: readonly WorkflowNode[];
  issues: readonly WorkflowIssue[];
  workflowName: string;
  catalog: ExtensionCatalog;
};

/** What a kind's own `Header` component receives from the shell. */
export type RevealKindHeaderProps = {
  subject: RevealSubject;
  level: OpenRevealLevel;
  controls: RevealHeaderControls;
};

/**
 * Who builds the header, which the shell renders above the body in either case.
 * `shell` renders `RevealHeader` from `model`. `kind` renders `Header`, which
 * reads its own atoms or queries and renders `RevealHeader` itself.
 */
export type RevealKindHeader =
  | {
      owner: "shell";
      model: (
        subject: RevealSubject,
        context: RevealHeaderContext
      ) => RevealHeaderModel;
    }
  | { owner: "kind"; Header: ComponentType<RevealKindHeaderProps> };

/**
 * What one Back or Escape does for `subject` at `level`. `unwindLevel` is the
 * shell's own step back.
 */
export type RevealUnwind = (input: {
  subject: RevealSubject;
  level: OpenRevealLevel;
  store: ReturnType<typeof createStore>;
  unwindLevel: () => void;
  /**
   * Hand DOM focus back to what opened Reveal at the next close, for a kind
   * that closes Reveal through its own write.
   */
  returnFocusOnClose: () => void;
  /** Replace the editor route search, adding no history entry. */
  replaceRouteSearch: (search: WorkflowRouteSearch) => void;
}) => void;

export type RevealKind = {
  id: RevealKindId;
  /**
   * The subject this kind shows for a selection, or null. The subject lists the
   * open levels it offers, so the kind decides whether Focus exists. `get`
   * reads any further state only this kind matches on.
   */
  match: (input: RevealMatchInput, get: Getter) => RevealSubject | null;
  /** The accessible name of the Reveal region while it shows this kind. */
  regionLabel: string;
  header: RevealKindHeader;
  Browse: ComponentType<RevealBodyProps>;
  /** The Focus body, for a kind whose subjects can offer Focus. */
  Focus: ComponentType<RevealBodyProps> | null;
  /**
   * What one Back or Escape does on desktop. Without it the shell runs
   * `unwindLevel`, which goes from Focus to Browse to Closed.
   */
  unwind?: RevealUnwind;
  /**
   * How the kind shows in the mobile Reveal sequence below `md`, for a kind
   * whose sheets need more than the shell builds for Draft. `Header` renders
   * the sheet header, usually `MobileSheetHeader`, with the shell's controls.
   * `Body` replaces the default body, which is `Focus` on an inspector sheet
   * and `Browse` on a summary sheet. `unwind` answers Back and Escape on a
   * phone, where `unwindLevel` removes the top sheet; the default removes the
   * top sheet. After Back, `backFocusTarget` names the element in the sheet
   * that takes focus when the body moved none. `shellOwnsScroll` replaces the
   * kind's own value for the sheet body.
   */
  mobile?: {
    Header: ComponentType<{
      state: MobileRevealState;
      controls: MobileSheetControls;
    }>;
    Body?: ComponentType<RevealBodyProps>;
    unwind?: RevealUnwind;
    backFocusTarget?: (sheet: HTMLElement) => HTMLElement | null;
    shellOwnsScroll?: boolean;
  };
  /** The canvas element focus returns to when Reveal closes, when there is one. */
  focusReturnTarget: (
    subject: RevealSubject,
    area: HTMLElement
  ) => HTMLElement | null;
  /**
   * Whether the shell scrolls the body and remembers its scroll per level.
   * A kind that sets it false scrolls inside its own body.
   */
  shellOwnsScroll: boolean;
  /** How wide Focus is. */
  focusWidth: RevealFocusWidth;
};

/** The React Flow node element of `nodeId` inside the canvas area. */
function canvasNodeElement(
  subject: RevealSubject,
  area: HTMLElement
): HTMLElement | null {
  return subject.nodeId === null
    ? null
    : area.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(subject.nodeId)}"]`
      );
}

/** Ready with no issues, and otherwise the count in the tone of the worst one. */
function issueStatus(
  issues: readonly { severity: "blocking" | "warning" }[]
): RevealHeaderModel["status"] {
  if (issues.length === 0) {
    return { text: "Ready", tone: "muted" };
  }
  return {
    text: `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`,
    tone: issues.some((issue) => issue.severity === "blocking")
      ? "destructive"
      : "warning",
  };
}

function stepHeaderModel(
  subject: RevealSubject,
  context: RevealHeaderContext
): RevealHeaderModel {
  const node = context.nodes.find((item) => item.id === subject.nodeId);
  const actionType = readConfigString(node?.data.config, "actionType");
  const title =
    node && !isBlank(node.data.label)
      ? node.data.label
      : ((actionType && findAction(context.catalog, actionType)?.label) ??
        "Untitled step");
  const parentGroupLabel = node?.parentId
    ? context.nodes.find((item) => item.id === node.parentId)?.data.label
    : undefined;
  const issues = context.issues.filter(
    (issue) => issue.nodeId === subject.nodeId
  );
  return {
    workspaceLabel: "Draft",
    title,
    path: compact([
      context.workflowName || "Untitled workflow",
      parentGroupLabel,
      title,
    ]),
    status: issueStatus(issues),
    showsBack: true,
  };
}

function groupHeaderModel(
  subject: RevealSubject,
  context: RevealHeaderContext
): RevealHeaderModel {
  const node = context.nodes.find((item) => item.id === subject.nodeId);
  const title = groupLabel(node?.data.label);
  return {
    workspaceLabel: "Draft",
    title,
    path: [context.workflowName || "Untitled workflow", title],
    // The collapsed card hides the Group's steps, so the status counts their
    // issues with the Group's own.
    status:
      node && subject.nodeId !== null
        ? issueStatus(
            groupIssues({
              issues: context.issues,
              nodes: context.nodes,
              groupId: subject.nodeId,
            })
          )
        : null,
    showsBack: true,
  };
}

function lifecycleHeaderModel(
  subject: RevealSubject,
  context: RevealHeaderContext
): RevealHeaderModel {
  const node = context.nodes.find((item) => item.id === subject.nodeId);
  const title =
    node && !isBlank(node.data.label) ? node.data.label : "Lifecycle";
  return {
    workspaceLabel: "Draft",
    title,
    path: [context.workflowName || "Untitled workflow", title],
    status: node
      ? issueStatus(
          context.issues.filter((issue) => issue.nodeId === subject.nodeId)
        )
      : null,
    showsBack: true,
  };
}

function StepFocus({ subject, frame }: RevealBodyProps) {
  return subject.nodeId === null ? null : (
    <NodePropertiesForm frame={frame} nodeId={subject.nodeId} />
  );
}

/**
 * The complete form of a Group frame: label and description, its steps, Enter
 * group, and its commands.
 */
function GroupFocus({ subject, frame }: RevealBodyProps) {
  return subject.nodeId === null ? null : (
    <NodePropertiesForm frame={frame} nodeId={subject.nodeId}>
      <GroupFocusSections groupId={subject.nodeId} />
    </NodePropertiesForm>
  );
}

function PanelBrowse({ frame }: RevealBodyProps) {
  return <NodeConfigPanel frame={frame} />;
}

/**
 * The node config panel's header in Draft: its own title, which names
 * Properties or Connection, with no path and no status.
 */
function PanelHeader({ level, controls }: RevealKindHeaderProps) {
  const title = useNodeConfigTitle();
  return (
    <RevealHeader
      controls={controls}
      level={level}
      model={{
        workspaceLabel: "Draft",
        title,
        path: [],
        status: null,
        showsBack: false,
      }}
    />
  );
}

/**
 * One step back in Changes: from version history in Browse to the change list,
 * from Focus to the change list in Browse with DOM focus on the inspected
 * object's row, and otherwise one level. The row focus request is set only
 * when a comparison is shown, since only then does the list render.
 */
function unwindChanges({
  store,
  level,
  unwindLevel,
}: Parameters<RevealUnwind>[0]) {
  const comparison = store.get(comparisonRevealContextAtom);
  const workflowId = store.get(currentWorkflowIdAtom);
  const showsHistory = "payload" in comparison && comparison.showsHistory;
  if (showsHistory && workflowId) {
    store.set(setComparisonSubviewAtom, { workflowId, subview: "review" });
  }
  if (level === "browse" && showsHistory && workflowId) {
    return;
  }
  if (level === "focus" && "payload" in comparison) {
    store.set(
      changeRowFocusRequestAtom,
      workspaceAddressId(store.get(activeWorkspaceAddressAtom))
    );
  }
  unwindLevel();
}

/** A Draft ordinary step: a summary in Browse and its complete form in Focus. */
const STEP_KIND: RevealKind = {
  id: "step",
  match: matchStepSubject,
  regionLabel: "Step inspector",
  header: { owner: "shell", model: stepHeaderModel },
  Browse: StepBrowse,
  Focus: StepFocus,
  unwind: unwindToInspectedOrigin,
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
  focusWidth: "standard",
};

/**
 * A Draft Condition: its rules as sentences and where each branch leads in
 * Browse, and the rule builder with its inputs, branches and issues in Focus.
 */
const CONDITION_KIND: RevealKind = {
  id: "condition",
  match: matchConditionSubject,
  regionLabel: "Condition inspector",
  header: { owner: "shell", model: stepHeaderModel },
  Browse: ConditionBrowse,
  Focus: ConditionFocus,
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
  focusWidth: "standard",
};

/**
 * A Draft Group frame on the overview: a summary and Enter group in Browse, and
 * the frame's form in Focus.
 */
const GROUP_KIND: RevealKind = {
  id: "group",
  match: matchGroupSubject,
  regionLabel: "Group inspector",
  header: { owner: "shell", model: groupHeaderModel },
  Browse: GroupBrowse,
  Focus: GroupFocus,
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
  focusWidth: "standard",
};

/**
 * The Draft Lifecycle Node: its policy summary in Browse and the sectioned
 * policy editor in a wide Focus, which still leaves room to place the node.
 */
const LIFECYCLE_KIND: RevealKind = {
  id: "lifecycle",
  match: matchLifecycleSubject,
  regionLabel: "Lifecycle inspector",
  header: { owner: "shell", model: lifecycleHeaderModel },
  Browse: LifecycleBrowse,
  Focus: LifecycleFocus,
  unwind: unwindToInspectedOrigin,
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
  focusWidth: "wide",
};

/**
 * A Draft Event Split: which Event source its outlets come from, with the
 * action that opens that source, and every outlet with its Event identity and
 * stored connection. Browse is its only level, because its outlets follow the
 * graph above it.
 */
const EVENT_SPLIT_KIND: RevealKind = {
  id: "eventSplit",
  match: matchEventSplitSubject,
  regionLabel: "Event Split inspector",
  header: { owner: "shell", model: stepHeaderModel },
  Browse: EventSplitBrowse,
  Focus: null,
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
  focusWidth: "standard",
};

/**
 * Runs: the run list, or the open run's summary, journey, and actions in
 * Browse, and a run node's evidence in Focus. One body renders both levels, so
 * the run overview keeps its state while Focus shows. Its header names the open
 * run and the inspected node; Back leaves Focus for the run, and the run for
 * the list. On mobile the run list and the run each show as their address's
 * sheet, and the evidence as the inspector over the run's sheet, with the same
 * Back.
 */
const RUNS_KIND: RevealKind = {
  id: "runs",
  match: (input, get) =>
    matchRunsSubject({
      ...input,
      chosenExecution: get(activeChosenExecutionAtom),
    }),
  regionLabel: "Runs inspector",
  header: { owner: "kind", Header: RunsHeader },
  Browse: RunsBody,
  Focus: RunsBody,
  unwind: unwindRuns,
  mobile: { Header: RunsMobileHeader, unwind: unwindRuns },
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: false,
  focusWidth: "standard",
};

/**
 * The Changes workspace: the comparison summary, the changed-object list, and
 * version history in Browse, and the selected object's before-and-after
 * properties side by side in a wide Focus, under a header naming the
 * comparison. Each body keeps its own scroll. On mobile the summary and the
 * change list are address sheets, version history an address inspector, and
 * the field differences the inspector of one object, each scrolled by the
 * shell.
 */
const CHANGES_KIND: RevealKind = {
  id: "changes",
  match: matchChangesSubject,
  regionLabel: "Changes inspector",
  header: { owner: "kind", Header: ChangesHeader },
  Browse: ChangesBrowse,
  Focus: ChangesFocus,
  unwind: unwindChanges,
  mobile: {
    Header: ChangesMobileHeader,
    Body: ChangesMobileBody,
    // The row of the object the field differences showed last, which Previous
    // and Next can have moved away from the row that opened them.
    backFocusTarget: (sheet) =>
      sheet.querySelector<HTMLElement>(
        '[data-slot="change-list"] [aria-pressed="true"]'
      ),
    shellOwnsScroll: true,
  },
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: false,
  focusWidth: "wide",
};

/**
 * The node config panel at Browse, for every Draft selection no other kind
 * shows. It scrolls inside its own body.
 */
const PANEL_KIND: RevealKind = {
  id: "panel",
  match: matchPanelSubject,
  regionLabel: "Inspector",
  header: { owner: "kind", Header: PanelHeader },
  Browse: PanelBrowse,
  Focus: null,
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: false,
  focusWidth: "standard",
};

/** Every kind, in the order a selection is matched against them. */
const REVEAL_KINDS: readonly RevealKind[] = [
  STEP_KIND,
  CONDITION_KIND,
  GROUP_KIND,
  EVENT_SPLIT_KIND,
  LIFECYCLE_KIND,
  RUNS_KIND,
  CHANGES_KIND,
  PANEL_KIND,
];

const REVEAL_KINDS_BY_ID: Readonly<Record<RevealKindId, RevealKind>> = {
  step: STEP_KIND,
  condition: CONDITION_KIND,
  group: GROUP_KIND,
  eventSplit: EVENT_SPLIT_KIND,
  lifecycle: LIFECYCLE_KIND,
  runs: RUNS_KIND,
  changes: CHANGES_KIND,
  panel: PANEL_KIND,
};

/** The subject of the first kind that matches the selection, or null. */
export function revealSubject(
  input: RevealMatchInput,
  get: Getter
): RevealSubject | null {
  for (const kind of REVEAL_KINDS) {
    const subject = kind.match(input, get);
    if (subject) {
      return subject;
    }
  }
  return null;
}

export function revealKind(subject: RevealSubject): RevealKind {
  return REVEAL_KINDS_BY_ID[subject.kind];
}
