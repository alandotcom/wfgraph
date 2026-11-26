/**
 * The subject kinds the details column and the phone's sheets can show, one
 * record each: `header` builds the header, `unwind` answers Back and Escape,
 * `mobile` adapts the sheets below `md`, and `shellOwnsScroll` names the
 * body's scroller. The shell keys the body by kind, so one component
 * registered as both `Browse` and `Focus` stays mounted. A Draft object has
 * one level, Browse, which shows its editor.
 */

import { startNodeTitle } from "@wfgraph/shared/graph/node-display";
import type { ComponentType } from "react";
import type { NodeConfigFrame } from "#src/components/workflow/node-config-panel";
import {
  NodeConfigPanel,
  useNodeConfigTitle,
} from "#src/components/workflow/node-config-panel";
import { groupLabel, type WorkflowNode } from "#src/lib/workflow-graph-types";
import type {
  RevealLevel,
  WorkflowRouteSearch,
} from "#src/lib/workflow-navigation-state";
import { groupIssues } from "#src/lib/workflow-issues-store";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import type { DesktopPresentation } from "#src/lib/workflow-navigation-state";
import {
  ACTION_TYPE_CONFIG_KEY,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { isBlank } from "@wfgraph/shared/types/string";
import type { Getter } from "jotai";
import type { Store } from "jotai";
import { activeChosenExecutionAtom } from "#src/lib/workflow-workspace-navigation";
import { ConditionEditor, ConditionSummarySheet } from "./condition-reveal";
import { EventSplitBrowse } from "./event-split-reveal";
import { GroupEditor, GroupSummarySheet } from "./group-browse";
import { LifecycleSummarySheet } from "./lifecycle-browse";
import { LifecycleEditor, LifecycleFocus } from "./lifecycle-focus";
import type { MobileRevealState } from "./canvas-reveal-state";
import type { MobileSheetControls } from "./mobile-sheet-header";
import {
  RevealHeader,
  type RevealHeaderControls,
  type RevealHeaderModel,
} from "./reveal-header";
import {
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
import {
  inspectedOriginNodeId,
  unwindToInspectedOrigin,
} from "./reveal-origin";
import {
  RunsBody,
  RunsHeader,
  RunsMobileHeader,
  unwindRuns,
} from "./runs-browse";
import { StepEditor, StepSummarySheet } from "./step-browse";

export type RevealBodyProps = {
  subject: RevealSubject;
  /**
   * The level the body is shown at. A kind that names one component for both
   * Browse and Focus reads it, and that component stays mounted between them.
   */
  level: RevealLevel;
  frame: NodeConfigFrame;
  /**
   * Move keyboard focus to the element whose id is `targetId` once it shows:
   * a field's config key, or the `headingId` of a section. On a phone's
   * summary sheet it opens the full-screen editor first, which it also does
   * with no `targetId`.
   */
  focusField: (targetId?: string) => void;
  /**
   * Scroll the body to its top without recording a scroll, for a body that
   * replaces what it shows after a navigation write already reset its scroll.
   */
  scrollToTop: () => void;
  /**
   * The mobile Reveal sheet the body shows on below `md`, or null when the
   * details column shows it. The shell passes it so a body reads the sheet
   * without importing the state module, which imports every kind.
   */
  mobile: MobileRevealState | null;
};

/** The graph state the shell reads for a header it builds from a model. */
export type RevealHeaderContext = {
  nodes: readonly WorkflowNode[];
  issues: readonly WorkflowIssue[];
  catalog: ExtensionCatalog;
  /** The active scope's desktop presentation, which records where a jump began. */
  presentation: DesktopPresentation;
};

/** What a kind's mobile sheet `Header` component receives from the shell. */
export type MobileKindHeaderProps = {
  state: MobileRevealState;
  controls: MobileSheetControls;
};

/** What a kind's own `Header` component receives from the shell. */
export type RevealKindHeaderProps = {
  subject: RevealSubject;
  level: RevealLevel;
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
  level: RevealLevel;
  /**
   * What asked: the Back control, or Escape. The Lifecycle kind's Escape
   * closes a section open for editing before it steps back, and its Back steps
   * back at once.
   */
  trigger: "back" | "escape";
  store: Store;
  unwindLevel: () => void;
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
  /** The accessible name of the details region while it shows this kind. */
  regionLabel: string;
  header: RevealKindHeader;
  /** The body at Browse, which for a Draft object is its editor. */
  Browse: ComponentType<RevealBodyProps>;
  /** The Focus body, for a kind whose subjects can offer Focus. */
  Focus: ComponentType<RevealBodyProps> | null;
  /**
   * What one Back or Escape does on desktop. Without it the shell runs
   * `unwindLevel`, which goes from Focus to Browse, and from Browse hands
   * focus back to the canvas.
   */
  unwind?: RevealUnwind;
  /**
   * How the kind shows in the mobile Reveal sequence below `md`. `Header`
   * renders the sheet header, usually `MobileSheetHeader`, with the shell's
   * controls; without it the shell builds one from the kind's header model.
   * `Summary` is the summary sheet's body, `Browse` by default, and
   * `Inspector` is the inspector sheet's body, `Focus` by default.
   * `inspectorLabel` names the control in the shell's header that opens the
   * inspector sheet, which a kind without it does not offer. `unwind` answers
   * Back and Escape on a phone, where `unwindLevel` removes the top sheet; the
   * default removes the top sheet. After Back, `backFocusTarget` names the
   * element in the sheet that takes focus when the body moved none.
   * `shellOwnsScroll` replaces the kind's own value for the sheet body.
   */
  mobile?: {
    Header?: ComponentType<MobileKindHeaderProps>;
    Summary?: ComponentType<RevealBodyProps>;
    Inspector?: ComponentType<RevealBodyProps>;
    inspectorLabel?: string;
    unwind?: RevealUnwind;
    backFocusTarget?: (sheet: HTMLElement) => HTMLElement | null;
    shellOwnsScroll?: boolean;
  };
  /** The canvas element Escape hands focus back to, when there is one. */
  focusReturnTarget: (
    subject: RevealSubject,
    area: HTMLElement
  ) => HTMLElement | null;
  /**
   * Whether the shell scrolls the body and remembers its scroll per level.
   * A kind that sets it false scrolls inside its own body.
   */
  shellOwnsScroll: boolean;
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

/**
 * Whether Back has somewhere to go: the object a jump reached, such as a Wait
 * opened from an Event Split, returns to where the jump began.
 */
function hasWayBack(
  subject: RevealSubject,
  context: RevealHeaderContext
): boolean {
  return (
    inspectedOriginNodeId({
      presentation: context.presentation,
      subject,
      nodes: context.nodes,
    }) !== null
  );
}

function stepHeaderModel(
  subject: RevealSubject,
  context: RevealHeaderContext
): RevealHeaderModel {
  const node = context.nodes.find((item) => item.id === subject.nodeId);
  const actionType = readConfigString(
    node?.data.config,
    ACTION_TYPE_CONFIG_KEY
  );
  const title =
    node && !isBlank(node.data.label)
      ? node.data.label
      : ((actionType && findAction(context.catalog, actionType)?.label) ??
        "Untitled step");
  const issues = context.issues.filter(
    (issue) => issue.nodeId === subject.nodeId
  );
  return {
    title,
    // A disabled step is not ready for anything: a run stops on reaching it.
    status:
      node?.data.enabled === false
        ? { text: "Disabled", tone: "muted" }
        : issueStatus(issues),
    showsBack: hasWayBack(subject, context),
  };
}

function groupHeaderModel(
  subject: RevealSubject,
  context: RevealHeaderContext
): RevealHeaderModel {
  const node = context.nodes.find((item) => item.id === subject.nodeId);
  const title = groupLabel(node?.data.label);
  return {
    title,
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
    showsBack: hasWayBack(subject, context),
  };
}

function lifecycleHeaderModel(
  subject: RevealSubject,
  context: RevealHeaderContext
): RevealHeaderModel {
  const node = context.nodes.find((item) => item.id === subject.nodeId);
  const title = node ? startNodeTitle(context.catalog, node.data) : "Start";
  return {
    title,
    status: node
      ? issueStatus(
          context.issues.filter((issue) => issue.nodeId === subject.nodeId)
        )
      : null,
    showsBack: hasWayBack(subject, context),
  };
}

function PanelBrowse({ frame }: RevealBodyProps) {
  return <NodeConfigPanel frame={frame} />;
}

/**
 * The node config panel's header in Draft: its own title, which names
 * Properties or Connection, with no status.
 */
function PanelHeader({ controls }: RevealKindHeaderProps) {
  const title = useNodeConfigTitle();
  return (
    <RevealHeader
      controls={controls}
      model={{
        title,
        status: null,
        showsBack: false,
      }}
    />
  );
}

/**
 * A Draft ordinary step: its complete form. A phone shows a summary sheet and
 * the form in the full-screen editor.
 */
const STEP_KIND: RevealKind = {
  id: "step",
  match: matchStepSubject,
  regionLabel: "Step inspector",
  header: { owner: "shell", model: stepHeaderModel },
  Browse: StepEditor,
  Focus: null,
  unwind: unwindToInspectedOrigin,
  mobile: {
    Summary: StepSummarySheet,
    Inspector: StepEditor,
    inspectorLabel: "Edit step",
  },
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
};

/**
 * A Draft Condition: when it takes True, the rule builder, where each branch
 * leads, and its inputs. A phone shows its rules as sentences on a summary
 * sheet and the rule builder in the full-screen editor.
 */
const CONDITION_KIND: RevealKind = {
  id: "condition",
  match: matchConditionSubject,
  regionLabel: "Condition inspector",
  header: { owner: "shell", model: stepHeaderModel },
  Browse: ConditionEditor,
  Focus: null,
  mobile: {
    Summary: ConditionSummarySheet,
    Inspector: ConditionEditor,
    inspectorLabel: "Edit rules",
  },
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
};

/**
 * A Draft Group frame: its label and description, its summary, and its
 * commands. A phone shows the summary on a
 * summary sheet and the rest in the full-screen editor.
 */
const GROUP_KIND: RevealKind = {
  id: "group",
  match: matchGroupSubject,
  regionLabel: "Group inspector",
  header: { owner: "shell", model: groupHeaderModel },
  Browse: GroupEditor,
  Focus: null,
  mobile: {
    Summary: GroupSummarySheet,
    Inspector: GroupEditor,
    inspectorLabel: "Edit group",
  },
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
};

/**
 * The Draft Lifecycle Node: its rules as one always-editable form. A phone
 * shows a summary on a summary sheet, and each section's Edit opens the
 * sectioned full-screen editor at that section.
 */
const LIFECYCLE_KIND: RevealKind = {
  id: "lifecycle",
  match: matchLifecycleSubject,
  regionLabel: "Start details",
  header: { owner: "shell", model: lifecycleHeaderModel },
  Browse: LifecycleEditor,
  Focus: null,
  unwind: unwindToInspectedOrigin,
  mobile: {
    Summary: LifecycleSummarySheet,
    Inspector: LifecycleFocus,
  },
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
};

/**
 * A Draft Event Split: which Event source its outlets come from, with the
 * action that opens that source, and every outlet with its Event identity and
 * stored connection. It has no editor, because its outlets follow the graph
 * above it.
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
};

/** Every kind, in the order a selection is matched against them. */
const REVEAL_KINDS: readonly RevealKind[] = [
  STEP_KIND,
  CONDITION_KIND,
  GROUP_KIND,
  EVENT_SPLIT_KIND,
  LIFECYCLE_KIND,
  RUNS_KIND,
  PANEL_KIND,
];

const REVEAL_KINDS_BY_ID: Readonly<Record<RevealKindId, RevealKind>> = {
  step: STEP_KIND,
  condition: CONDITION_KIND,
  group: GROUP_KIND,
  eventSplit: EVENT_SPLIT_KIND,
  lifecycle: LIFECYCLE_KIND,
  runs: RUNS_KIND,
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
