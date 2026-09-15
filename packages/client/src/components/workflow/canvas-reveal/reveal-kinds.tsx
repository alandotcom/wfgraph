/**
 * The subject kinds Canvas Reveal can show, one record each; the shell looks the
 * kind up once and renders it generically. A body receives `openFocus`, which
 * shows Focus and, given a config key, focuses that field: every Focus form
 * renders a field's control with its config key as the element id.
 */

import type { ComponentType } from "react";
import type { NodeConfigFrame } from "#src/components/workflow/node-config-panel";
import { NodeConfigPanel } from "#src/components/workflow/node-config-panel";
import { NodePropertiesForm } from "#src/components/workflow/node-properties-form";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import type { WorkflowIssue } from "@wfgraph/shared/graph/workflow-issues";
import { isBlank } from "@wfgraph/shared/types/string";
import { compact } from "es-toolkit/array";
import type { RevealHeaderModel } from "./reveal-header";
import {
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
  /** Show Focus, then focus the field whose config key is `fieldKey`. */
  openFocus: (fieldKey?: string) => void;
};

/** What a header model reads beside the subject. */
export type RevealHeaderContext = {
  nodes: readonly WorkflowNode[];
  issues: readonly WorkflowIssue[];
  workflowName: string;
  catalog: ExtensionCatalog;
  /** The node config panel's own title for the current selection. */
  panelTitle: string;
};

export type RevealKind = {
  id: RevealKindId;
  /**
   * The subject this kind shows for a selection, or null. The subject lists the
   * open levels it offers, so the kind decides whether Focus exists.
   */
  match: (input: RevealMatchInput) => RevealSubject | null;
  headerModel: (
    subject: RevealSubject,
    context: RevealHeaderContext
  ) => RevealHeaderModel;
  Browse: ComponentType<RevealBodyProps>;
  /** The Focus body, for a kind whose subjects can offer Focus. */
  Focus: ComponentType<RevealBodyProps> | null;
  /** The canvas element focus returns to when Reveal closes, when there is one. */
  focusReturnTarget: (
    subject: RevealSubject,
    area: HTMLElement
  ) => HTMLElement | null;
  /** Whether the shell scrolls the body and remembers its scroll per level. */
  keepsInspectorScroll: boolean;
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
    regionLabel: "Step inspector",
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

/** A Draft ordinary step: a summary in Browse and its complete form in Focus. */
const STEP_KIND: RevealKind = {
  id: "step",
  match: matchStepSubject,
  headerModel: stepHeaderModel,
  Browse: StepBrowse,
  Focus: StepFocus,
  focusReturnTarget: canvasNodeElement,
  keepsInspectorScroll: true,
};

/**
 * The node config panel at Browse, for every subject no other kind shows: Runs,
 * Changes, and any other Draft selection. Its title names the panel.
 */
const PANEL_KIND: RevealKind = {
  id: "panel",
  match: matchPanelSubject,
  headerModel: (subject, context) => ({
    regionLabel: `${context.panelTitle} inspector`,
    workspaceLabel: subject.workspace === "draft" ? "Draft" : null,
    title: context.panelTitle,
    path: [],
    status: null,
    showsBack: false,
  }),
  Browse: PanelBrowse,
  Focus: null,
  focusReturnTarget: canvasNodeElement,
  keepsInspectorScroll: false,
};

/** Every kind, in the order a selection is matched against them. */
const REVEAL_KINDS: readonly RevealKind[] = [STEP_KIND, PANEL_KIND];

const REVEAL_KINDS_BY_ID: Readonly<Record<RevealKindId, RevealKind>> = {
  step: STEP_KIND,
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
