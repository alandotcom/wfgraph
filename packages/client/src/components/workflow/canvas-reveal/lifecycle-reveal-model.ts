/**
 * What the Lifecycle bodies share: the sections in order, the section an issue
 * opens, and the section a scope has open. The section lives in the scope's
 * navigation state beside the inspector scroll, so both restore together.
 */

import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  type ExtensionCatalog,
  uniqueIntegrationsOfEvents,
} from "@wfgraph/shared/extensions/catalog";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { readStartFilter } from "@wfgraph/shared/lifecycle/start-filters";
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
  { id: "start-events", label: "Starts when" },
  { id: "overlapping-runs", label: "Overlapping runs" },
  { id: "schedule", label: "Schedule" },
  { id: "cancel-events", label: "Cancel Events" },
  { id: "entity-eligibility", label: "Entity" },
  { id: "connections", label: "Event Connections" },
  { id: "validation", label: "Validation" },
] as const;

export type LifecycleSectionId = (typeof LIFECYCLE_SECTIONS)[number]["id"];

/**
 * The rules "Add a rule" offers, named for what each does, with the section
 * that edits it. A Start Filter is written in the Start Events section, and
 * the Entity and its eligibility rule share one section.
 */
const LIFECYCLE_RULE_CHOICES = [
  { id: "start-filter", label: "Only start when…", section: "start-events" },
  { id: "cancel-events", label: "Stop a run when…", section: "cancel-events" },
  {
    id: "overlapping-runs",
    label: "If a run is already in progress…",
    section: "overlapping-runs",
  },
  { id: "schedule", label: "On a schedule…", section: "schedule" },
  {
    id: "entity",
    label: "Tie each run to a record…",
    section: "entity-eligibility",
  },
  {
    id: "eligibility",
    label: "Only run while the record matches…",
    section: "entity-eligibility",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  section: LifecycleSectionId;
}>;

type LifecycleRuleChoice = (typeof LIFECYCLE_RULE_CHOICES)[number];

/** Whether the rule each choice adds is already set in `rules`. */
const RULE_IS_SET: Readonly<
  Record<LifecycleRuleChoice["id"], (rules: LifecycleRules) => boolean>
> = {
  "start-filter": (rules) =>
    rules.startEvents.some((name) => readStartFilter(rules, name)),
  "cancel-events": (rules) => rules.cancelEvents.length > 0,
  "overlapping-runs": (rules) => rules.concurrency !== "unlimited",
  schedule: (rules) => (rules.schedules?.length ?? 0) > 0,
  entity: (rules) => rules.trackedEntity !== undefined,
  eligibility: (rules) => rules.entityEligibility !== undefined,
};

/**
 * The rules "Add a rule" offers for `rules`: each one not set yet. "Only
 * start when…" waits for a Start Event, since a Start Filter reads one.
 */
export function offeredLifecycleRules(
  rules: LifecycleRules
): readonly LifecycleRuleChoice[] {
  return LIFECYCLE_RULE_CHOICES.filter(
    (choice) =>
      !RULE_IS_SET[choice.id](rules) &&
      (choice.id !== "start-filter" || rules.startEvents.length > 0)
  );
}

/**
 * Whether the start's details show `section` for `rules`. What starts a run
 * always shows. A rule shows once it is set. Event Connections show whenever
 * a Start or Cancel Event arrives through an integration, because such an
 * Event reaches no run until a Connection is chosen, and Validation shows
 * while the start has an issue. The section open for editing shows too, which
 * is how a rule being added appears before it is set.
 */
export function lifecycleSectionShown(input: {
  section: LifecycleSectionId;
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  issueCount: number;
}): boolean {
  const { rules, section } = input;
  if (section === "start-events") {
    return true;
  }
  if (section === "connections") {
    return (
      uniqueIntegrationsOfEvents(input.catalog, [
        ...rules.startEvents,
        ...rules.cancelEvents,
      ]).length > 0
    );
  }
  if (section === "validation") {
    return input.issueCount > 0;
  }
  if (section === "entity-eligibility") {
    return RULE_IS_SET.entity(rules) || RULE_IS_SET.eligibility(rules);
  }
  return RULE_IS_SET[section](rules);
}

/** The sections a person can remove, which is every optional rule's. */
export type RemovableLifecycleSection =
  | "overlapping-runs"
  | "schedule"
  | "cancel-events"
  | "entity-eligibility";

/** Whether `section` holds a rule a person can remove. */
export function isRemovableLifecycleSection(
  section: LifecycleSectionId
): section is RemovableLifecycleSection {
  return (
    section === "overlapping-runs" ||
    section === "schedule" ||
    section === "cancel-events" ||
    section === "entity-eligibility"
  );
}

/**
 * `rules` with the rule `section` edits back at its default, which hides the
 * section again: every arrival starts its own run, no schedule, no Cancel
 * Event, or no tracked Entity and no eligibility rule. The rules editor's
 * prune then drops the filters, paths and bindings that rule held.
 */
export function withoutLifecycleRule(
  rules: LifecycleRules,
  section: RemovableLifecycleSection
): LifecycleRules {
  return { ...rules, ...RULE_DEFAULTS[section] };
}

/** The value of each removable rule that leaves it unset. */
const RULE_DEFAULTS: Readonly<
  Record<RemovableLifecycleSection, Partial<LifecycleRules>>
> = {
  "overlapping-runs": { concurrency: "unlimited" },
  schedule: { schedules: undefined },
  "cancel-events": { cancelEvents: [] },
  "entity-eligibility": {
    trackedEntity: undefined,
    entityEligibility: undefined,
  },
};

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
