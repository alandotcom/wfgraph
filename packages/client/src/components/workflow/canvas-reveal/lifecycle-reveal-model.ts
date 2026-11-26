/**
 * What the Lifecycle bodies share: the sections in order, which ones a start
 * shows, the rules "Add a rule" offers, the element each rule's focus lands
 * on, and the section an issue opens. The phone's full-screen editor shows one
 * section at a time, recorded on its sheet; the desktop form shows every rule
 * that is set and has no section state.
 */

import { START_RULE_NAMES } from "#src/components/workflow/config/lifecycle-policy-summary";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
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
import { recordMobileSheetSectionAtom } from "#src/lib/mobile-sheet-store";
import type { InspectedOrigin } from "#src/lib/workflow-navigation-state";
import {
  activeMobileSheetsAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import { useRevealNavigation } from "./use-reveal-navigation";

/** The start's sections in order, each titled with its rule's one name. */
export const LIFECYCLE_SECTIONS = [
  { id: "start-events", label: START_RULE_NAMES.starts },
  { id: "overlapping-runs", label: START_RULE_NAMES.overlapping },
  { id: "schedule", label: START_RULE_NAMES.schedule },
  { id: "cancel-events", label: START_RULE_NAMES.stop },
  { id: "entity-eligibility", label: START_RULE_NAMES.entity },
  { id: "connections", label: "Event Connections" },
  { id: "validation", label: "Validation" },
] as const;

/** The title of `section`. */
export function lifecycleSectionTitle(section: LifecycleSectionId): string {
  return (
    LIFECYCLE_SECTIONS.find((entry) => entry.id === section)?.label ?? section
  );
}

export type LifecycleSectionId = (typeof LIFECYCLE_SECTIONS)[number]["id"];

/**
 * The rules "Add a rule" offers, each by the name its section or form heading
 * carries, with the section that edits it. A Start Filter is written in the
 * "Starts when" section, and the Entity and its eligibility rule share one
 * section.
 */
const LIFECYCLE_RULE_CHOICES = [
  {
    id: "start-filter",
    label: `${START_RULE_NAMES.startFilter}…`,
    section: "start-events",
  },
  {
    id: "cancel-events",
    label: `${START_RULE_NAMES.stop}…`,
    section: "cancel-events",
  },
  {
    id: "overlapping-runs",
    label: `${START_RULE_NAMES.overlapping}…`,
    section: "overlapping-runs",
  },
  {
    id: "schedule",
    label: `${START_RULE_NAMES.schedule}…`,
    section: "schedule",
  },
  {
    id: "entity",
    label: `${START_RULE_NAMES.entity}…`,
    section: "entity-eligibility",
  },
  {
    id: "eligibility",
    label: `${START_RULE_NAMES.eligibility}…`,
    section: "entity-eligibility",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  section: LifecycleSectionId;
}>;

export type LifecycleRuleChoice = (typeof LIFECYCLE_RULE_CHOICES)[number];

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

/**
 * What a rule from "Add a rule" or a jump to a section moves focus to: a
 * section, or the Start Filter, which the "Starts when" rule holds.
 */
export type LifecycleRuleTarget = LifecycleSectionId | "start-filter";

/**
 * The element id of the first control of a rule in the Start's form, which
 * takes focus when the rule is added or a jump opens it: the Event picker of
 * "Starts when" or "Stop a run when", the dropdown of overlapping runs, Add
 * schedule, the Entity picker, or the first "Filter the arrivals".
 */
export function lifecycleRuleTargetId(target: LifecycleRuleTarget): string {
  return `lifecycle-rule-${target}`;
}

/** The element id of "Add a rule", where focus goes when a rule is removed. */
export const LIFECYCLE_ADD_RULE_ID = "lifecycle-add-rule";

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
 * Open the Lifecycle Node `nodeId` at `section` in the active address,
 * selecting it first when another object is selected. `origin`, when given,
 * records where the jump started, which Back returns to. On desktop the form
 * shows every rule, so focus moves to the section's first control. Below `md`
 * it opens the full-screen inspector sheet at `section` over the sheets
 * already open, which is itself the way Back returns.
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
      targetId: lifecycleRuleTargetId(section),
      origin,
    });
  };
}

/** The object the top mobile sheet shows, with the section it records. */
const mobileShownSectionAtom = atom((get) => {
  const top = get(activeMobileSheetsAtom).at(-1);
  return top?.inspected
    ? { inspected: top.inspected, section: top.section }
    : null;
});

/**
 * The section the phone's full-screen Lifecycle editor shows for the Lifecycle
 * Node `nodeId`, and `choose`, which records another section on its sheet. A
 * sheet showing a different object shows the first section.
 */
export function useLifecycleSection(nodeId: string): {
  section: LifecycleSectionId;
  choose: (section: LifecycleSectionId) => void;
} {
  const store = useStore();
  const shown = useAtomValue(mobileShownSectionAtom);
  const recordSection = useSetAtom(recordMobileSheetSectionAtom);
  const section = readSectionId(
    shown?.inspected.id === nodeId ? shown.section : null
  );
  return {
    section,
    choose: (next) => {
      recordSection({
        address: store.get(activeWorkspaceAddressAtom),
        inspected: { kind: "node", id: nodeId },
        section: next,
      });
    },
  };
}
