/**
 * What the Lifecycle bodies share: the sections in order, the section an issue
 * opens, and the section a scope has open. The section lives in the scope's
 * navigation state beside the inspector scroll, so both restore together.
 */

import { useAtomValue, useSetAtom, useStore } from "jotai";
import type {
  LifecycleRulesCheckId,
  WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import type {
  DesktopPresentation,
  InspectedOrigin,
} from "#src/lib/workflow-navigation-state";
import {
  activeRevealPresentationAtom,
  activeWorkspaceAddressAtom,
  recordInspectorSectionAtom,
} from "#src/lib/workflow-workspace-navigation";
import { useRevealNavigation } from "./use-reveal-navigation";

export const LIFECYCLE_SECTIONS = [
  { id: "start-events", label: "Start Events" },
  { id: "overlapping-runs", label: "Overlapping runs" },
  { id: "schedule", label: "Schedule" },
  { id: "cancel-events", label: "Cancel Events" },
  { id: "entity-eligibility", label: "Entity" },
  { id: "connections", label: "Event Connections" },
  { id: "validation", label: "Validation" },
] as const;

export type LifecycleSectionId = (typeof LIFECYCLE_SECTIONS)[number]["id"];

/** The section `value` names, or null when it names none. */
function findSectionId(value: string | null): LifecycleSectionId | null {
  return LIFECYCLE_SECTIONS.find((section) => section.id === value)?.id ?? null;
}

function readSectionId(value: string | null): LifecycleSectionId {
  return findSectionId(value) ?? LIFECYCLE_SECTIONS[0].id;
}

/** The element id of the heading of a section open for editing in place. */
export function lifecycleSectionHeadingId(section: LifecycleSectionId): string {
  return `lifecycle-section-${section}`;
}

/** The element id of a section summary's Edit button. */
export function lifecycleEditButtonId(section: LifecycleSectionId): string {
  return `lifecycle-edit-${section}`;
}

const LIFECYCLE_CHECK_SECTIONS: Readonly<
  Record<LifecycleRulesCheckId, LifecycleSectionId>
> = {
  rules: "start-events",
  start_filter: "start-events",
  cancel_filter: "cancel-events",
  entity_eligibility: "entity-eligibility",
  schedule: "schedule",
};

/**
 * The section that edits what `issue` names: the Start Events for a
 * Lifecycle Rules or Start Filter problem, the Schedule for a schedule problem,
 * the Cancel Events for a Cancel Filter problem, Entity eligibility for an
 * eligibility problem, and Validation for any other issue.
 */
export function lifecycleIssueSection(
  issue: WorkflowIssue
): LifecycleSectionId {
  if (issue.kind !== "invalid_lifecycle_rules") {
    return "validation";
  }
  return LIFECYCLE_CHECK_SECTIONS[issue.check];
}

/**
 * Open the Lifecycle Node `nodeId` with `section` open for editing in the
 * active address, selecting it first when another object is selected. `origin`, when given,
 * records where the jump started, which Back returns to. Below `md` it opens
 * the full-screen inspector sheet at `section` over the sheets already open,
 * which is itself the way Back returns.
 */
export function useOpenLifecycleSection(
  nodeId: string
): (section: LifecycleSectionId, origin?: InspectedOrigin) => void {
  const store = useStore();
  const navigation = useRevealNavigation();
  return (section, origin) => {
    navigation.openSection({
      address: store.get(activeWorkspaceAddressAtom),
      nodeId,
      section,
      origin,
    });
  };
}

/**
 * The section the phone's full-screen Lifecycle editor shows for the Lifecycle
 * Node `nodeId`, and `choose`, which records another section. An inspector
 * showing a different object shows the first section.
 */
export function useLifecycleSection(nodeId: string): {
  section: LifecycleSectionId;
  choose: (section: LifecycleSectionId) => void;
} {
  const store = useStore();
  const navigation = useRevealNavigation();
  const shown = useAtomValue(navigation.shownSectionAtom);
  const section = readSectionId(
    shown?.inspected.id === nodeId ? shown.section : null
  );
  return {
    section,
    choose: (next) => {
      navigation.recordSection({
        address: store.get(activeWorkspaceAddressAtom),
        nodeId,
        section: next,
      });
    },
  };
}

/**
 * The section of the Lifecycle Node `nodeId` that the details column has
 * open for editing in place, or null while every section shows its summary.
 * `open` and `close` record the change on the active scope.
 */
export function useLifecycleOpenSection(nodeId: string): {
  section: LifecycleSectionId | null;
  open: (section: LifecycleSectionId) => void;
  close: () => void;
} {
  const store = useStore();
  const presentation = useAtomValue(activeRevealPresentationAtom);
  const recordSection = useSetAtom(recordInspectorSectionAtom);
  const record = (section: LifecycleSectionId | null) =>
    recordSection({
      address: store.get(activeWorkspaceAddressAtom),
      inspectedId: nodeId,
      section,
    });
  return {
    section: lifecycleOpenSection(presentation, nodeId),
    open: record,
    close: () => record(null),
  };
}

/**
 * The section of the Lifecycle Node `nodeId` that `presentation` records as
 * open for editing in the details column, or null for none.
 */
export function lifecycleOpenSection(
  presentation: DesktopPresentation,
  nodeId: string
): LifecycleSectionId | null {
  return presentation.inspected?.id === nodeId
    ? findSectionId(presentation.inspectorSection)
    : null;
}
