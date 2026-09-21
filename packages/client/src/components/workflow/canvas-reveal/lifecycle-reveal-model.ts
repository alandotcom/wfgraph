/**
 * What the Lifecycle Browse and Focus bodies share: the Focus sections in
 * order, the section an issue opens, and the section a scope shows. The section
 * lives in the scope's navigation state beside the inspector scroll, so both
 * restore together.
 */

import { useAtomValue, useStore } from "jotai";
import type {
  LifecycleRulesCheckId,
  WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import type { InspectedOrigin } from "#src/lib/workflow-navigation-state";
import { activeWorkspaceAddressAtom } from "#src/lib/workflow-workspace-navigation";
import { useRevealNavigation } from "./use-reveal-navigation";

export const LIFECYCLE_SECTIONS = [
  { id: "start-events", label: "Start Events" },
  { id: "overlapping-runs", label: "Overlapping runs" },
  { id: "cancel-events", label: "Cancel Events" },
  { id: "entity-eligibility", label: "Entity" },
  { id: "connections", label: "Event Connections" },
  { id: "validation", label: "Validation" },
] as const;

export type LifecycleSectionId = (typeof LIFECYCLE_SECTIONS)[number]["id"];

function readSectionId(value: string | null): LifecycleSectionId {
  return (
    LIFECYCLE_SECTIONS.find((section) => section.id === value)?.id ??
    LIFECYCLE_SECTIONS[0].id
  );
}

const LIFECYCLE_CHECK_SECTIONS: Readonly<
  Record<LifecycleRulesCheckId, LifecycleSectionId>
> = {
  rules: "start-events",
  start_filter: "start-events",
  cancel_filter: "cancel-events",
  entity_eligibility: "entity-eligibility",
};

/**
 * The Focus section that edits what `issue` names: the Start Events for a
 * Lifecycle Rules or Start Filter problem, since those rules name the Events,
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
 * Open the Lifecycle Node `nodeId` at Focus on `section` in the active address,
 * selecting it first when another object is selected. `origin`, when given,
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
 * The Focus section the active scope shows for the Lifecycle Node `nodeId`,
 * and `choose`, which records another section. An inspector showing a
 * different object shows the first section.
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
