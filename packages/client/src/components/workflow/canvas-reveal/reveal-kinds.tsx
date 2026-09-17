/**
 * The subject kinds Canvas Reveal can show, one record each. `header` says who
 * builds the header, `unwind` what Back and Escape do, and `shellOwnsScroll`
 * who scrolls the body. `openFocus(targetId)` shows Focus and focuses the
 * element with that id: a field's config key, or a section heading's id.
 */

import type { ComponentType } from "react";
import type { NodeConfigFrame } from "#src/components/workflow/node-config-panel";
import {
  NodeConfigPanel,
  useNodeConfigTitle,
} from "#src/components/workflow/node-config-panel";
import { NodePropertiesForm } from "#src/components/workflow/node-properties-form";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import type { OpenRevealLevel } from "#src/lib/workflow-navigation-state";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { isBlank } from "@wfgraph/shared/types/string";
import { compact } from "es-toolkit/array";
import type { createStore } from "jotai";
import {
  RevealHeader,
  type RevealHeaderControls,
  type RevealHeaderModel,
} from "./reveal-header";
import { ConditionBrowse, ConditionFocus } from "./condition-reveal";
import {
  matchConditionSubject,
  matchPanelSubject,
  matchStepSubject,
  type RevealKindId,
  type RevealMatchInput,
  type RevealSubject,
} from "./reveal-subject";
import { StepBrowse } from "./step-browse";

export type RevealBodyProps = {
  subject: RevealSubject;
  frame: NodeConfigFrame;
  /**
   * Show Focus, then focus the element whose id is `targetId`: a field's
   * config key, or the `headingId` of a section.
   */
  openFocus: (targetId?: string) => void;
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

export type RevealKind = {
  id: RevealKindId;
  /**
   * The subject this kind shows for a selection, or null. The subject lists the
   * open levels it offers, so the kind decides whether Focus exists.
   */
  match: (input: RevealMatchInput) => RevealSubject | null;
  /** The accessible name of the Reveal region while it shows this kind. */
  regionLabel: string;
  header: RevealKindHeader;
  Browse: ComponentType<RevealBodyProps>;
  /** The Focus body, for a kind whose subjects can offer Focus. */
  Focus: ComponentType<RevealBodyProps> | null;
  /**
   * What one Back or Escape does for `subject`. Without it the shell runs
   * `unwindLevel`, which goes from Focus to Browse to Closed.
   */
  unwind?: (input: {
    subject: RevealSubject;
    level: OpenRevealLevel;
    store: ReturnType<typeof createStore>;
    unwindLevel: () => void;
  }) => void;
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
  const groupLabel = node?.parentId
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
      groupLabel,
      title,
    ]),
    status:
      issues.length === 0
        ? { text: "Ready", tone: "muted" }
        : {
            text: `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`,
            tone: issues.some((issue) => issue.severity === "blocking")
              ? "destructive"
              : "warning",
          },
    showsBack: true,
  };
}

function StepFocus({ subject, frame }: RevealBodyProps) {
  return subject.nodeId === null ? null : (
    <NodePropertiesForm frame={frame} nodeId={subject.nodeId} />
  );
}

function PanelBrowse({ frame }: RevealBodyProps) {
  return <NodeConfigPanel frame={frame} />;
}

/**
 * The node config panel's header: its own title, which names Runs, Changes,
 * Properties, or Connection, with no path and no status.
 */
function PanelHeader({ subject, level, controls }: RevealKindHeaderProps) {
  const title = useNodeConfigTitle();
  return (
    <RevealHeader
      controls={controls}
      level={level}
      model={{
        workspaceLabel: subject.workspace === "draft" ? "Draft" : null,
        title,
        path: [],
        status: null,
        showsBack: false,
      }}
    />
  );
}

/** A Draft ordinary step: a summary in Browse and its complete form in Focus. */
const STEP_KIND: RevealKind = {
  id: "step",
  match: matchStepSubject,
  regionLabel: "Step inspector",
  header: { owner: "shell", model: stepHeaderModel },
  Browse: StepBrowse,
  Focus: StepFocus,
  focusReturnTarget: canvasNodeElement,
  shellOwnsScroll: true,
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
};

/**
 * The node config panel at Browse, for every subject no other kind shows: Runs,
 * Changes, and any other Draft selection. It scrolls inside its own body.
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
  PANEL_KIND,
];

const REVEAL_KINDS_BY_ID: Readonly<Record<RevealKindId, RevealKind>> = {
  step: STEP_KIND,
  condition: CONDITION_KIND,
  panel: PANEL_KIND,
};

/** The subject of the first kind that matches the selection, or null. */
export function revealSubject(input: RevealMatchInput): RevealSubject | null {
  for (const kind of REVEAL_KINDS) {
    const subject = kind.match(input);
    if (subject) {
      return subject;
    }
  }
  return null;
}

export function revealKind(subject: RevealSubject): RevealKind {
  return REVEAL_KINDS_BY_ID[subject.kind];
}
