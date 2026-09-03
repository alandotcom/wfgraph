import { compact, uniq } from "es-toolkit/array";
import { isEqual } from "es-toolkit/predicate";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "#src/components/ui/button";
import { Label } from "#src/components/ui/label";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import { nanoid } from "nanoid";
import {
  EVENT_NAME_FIELD_PATH,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  type ConditionSelectableField,
  getSharedEventConditionFields,
  seedConditionModelForField,
} from "#src/lib/upstream-node-fields";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import { catalogEventChoices } from "./event-choices";
import {
  type CorrelationPathRequest,
  correlationPathRequestFor,
  type LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  readCancelFilter,
  readCancelFilterLayout,
} from "@wfgraph/shared/lifecycle/cancel-filters";
import {
  readStartFilter,
  readStartFilterLayout,
} from "@wfgraph/shared/lifecycle/start-filters";
import { ConditionBuilderRow } from "./condition-builder-row";
import { ConfigGroup } from "./config-section";
import { EventMultiCombobox } from "./event-combobox";

const ROLE_COPY = {
  start: {
    label: "Start Events",
    help: [
      "A run starts when one of these Events arrives.",
      "The Correlation Path is the payload field that identifies the entity. Runs with the same value belong to the same entity.",
      "A Filter stops an arrival from starting a run when its condition is false. Concurrency does not receive the arrival.",
      "With several Events, Concurrency decides what happens to a run already in progress.",
    ],
  },
  cancel: {
    label: "Cancel Events",
    help: [
      "Workflow Graph checks the Cancel Filter before reading the Correlation Path.",
      "If the Cancel Filter declines the Event, the runs in progress stay active.",
      "If the Cancel Filter accepts the Event, Workflow Graph reads the entity from the Event's Correlation Path and cancels matching runs.",
      "A canceled run leaves through the Canceled outlet.",
    ],
  },
} as const;

const FILTER_COPY = {
  start: {
    actionForAll: "filter for all Start Events",
    filterEach: "Filter each Event separately",
    recollapse: "Use one filter for every Event",
  },
  cancel: {
    actionForAll: "filter for all Cancel Events",
    filterEach: "Filter each Cancel Event separately",
    recollapse: "Use one filter for every Cancel Event",
  },
} as const;

/**
 * Both Event roles can filter an arrival before it changes a run.
 */
type LifecycleEventGroupProps = {
  role: "start" | "cancel";
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
  disabled: boolean;
  inputId: string;
  onEventNamesChange: (eventNames: string[]) => void;
  onCorrelationPathChange: (eventName: string, path: string) => void;
  /** Writes one Event's filter for this role. */
  onFilterChange: (eventName: string, model: string | undefined) => void;
  /** Writes the same filter to every Event with this role. */
  onFilterChangeForAll: (model: string | undefined) => void;
};

export function LifecycleEventGroup(props: LifecycleEventGroupProps) {
  const {
    role,
    rules,
    catalog,
    disabled,
    inputId,
    onEventNamesChange,
    onCorrelationPathChange,
  } = props;
  const copy = ROLE_COPY[role];
  const filterCopy = FILTER_COPY[role];
  const eventNames = role === "start" ? rules.startEvents : rules.cancelEvents;

  /**
   * The Events the builder asked to see filtered separately.
   *
   * The layout is otherwise read off the stored filters, so the moment two of
   * them differ there is nothing to choose: one control could not say what they
   * hold. This covers the step in between, a builder who has split the group but
   * has not yet made the filters differ.
   *
   * It records the Events rather than a flag, because a request is about the
   * group that was on screen when it was made. Adding or removing an Event
   * makes a different group, which collapses again, and the shared functions
   * that also decide layout read the stored filters alone and cannot see this.
   */
  const [splitFor, setSplitFor] = useState<readonly string[]>([]);
  const splitRequested = isEqual(splitFor, eventNames);

  /**
   * The filter storage for this Event role, read once.
   */
  const readFilter =
    props.role === "start" ? readStartFilter : readCancelFilter;

  /**
   * Whether the Events agree on one rule.
   *
   * Memoized on the role and the rules because it parses and compiles every
   * stored filter, and the panel writes the rules on each keystroke.
   */
  const layout = useMemo(
    () =>
      role === "start"
        ? readStartFilterLayout(rules)
        : readCancelFilterLayout(rules),
    [role, rules]
  );

  /**
   * The one control standing for every Event, when there is one.
   */
  const collapsed =
    eventNames.length > 1 && layout.collapsed && !splitRequested
      ? { model: layout.model, write: props.onFilterChangeForAll }
      : undefined;

  const perEventFilter = collapsed ? undefined : props.onFilterChange;

  /** Whether re-collapsing would only change the layout, losing no filter. */
  const canRecollapse =
    eventNames.length > 1 && layout.collapsed && splitRequested;

  return (
    <ConfigGroup
      className="py-3 first:pt-0 last:pb-0"
      help={copy.help.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
      label={copy.label}
      prominent
    >
      <div className="space-y-2">
        <EventPicker hasEvents={catalog.events.length > 0}>
          <Label className="sr-only" htmlFor={inputId}>
            {copy.label}
          </Label>
          <EventMultiCombobox
            choices={catalogEventChoices(catalog)}
            disabled={disabled}
            inputId={inputId}
            onValueChange={onEventNamesChange}
            value={eventNames}
          />
        </EventPicker>
        {eventNames.map((eventName) => (
          <ChosenEvent
            catalog={catalog}
            disabled={disabled}
            eventName={eventName}
            filter={
              perEventFilter
                ? {
                    model: readFilter(rules, eventName),
                    onChange: perEventFilter,
                  }
                : undefined
            }
            key={eventName}
            label={findEvent(catalog, eventName)?.label}
            onCommitPath={onCorrelationPathChange}
            onRemove={() =>
              onEventNamesChange(
                eventNames.filter((entry) => entry !== eventName)
              )
            }
            role={role}
            request={correlationPathRequestFor({
              rules,
              catalog,
              eventName,
              role,
            })}
          />
        ))}
        {collapsed ? (
          <div className="space-y-1 rounded-md border px-2 py-1.5">
            <LifecycleFilterEditor
              actionName={filterCopy.actionForAll}
              disabled={disabled}
              eventNames={eventNames}
              model={collapsed.model}
              onChange={collapsed.write}
              role={role}
            />
            <FilterLayoutLink
              disabled={disabled}
              label={filterCopy.filterEach}
              onClick={() => setSplitFor(eventNames)}
            />
          </div>
        ) : null}
        {canRecollapse ? (
          <FilterLayoutLink
            disabled={disabled}
            label={filterCopy.recollapse}
            onClick={() => setSplitFor([])}
          />
        ) : null}
      </div>
    </ConfigGroup>
  );
}

/**
 * The switch between one filter and one per Event.
 *
 * Only ever offered where it changes nothing but the layout: collapsing while the
 * Events disagree would have to discard a filter to do it, so that direction is
 * offered again once they agree.
 */
function FilterLayoutLink({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      className="h-auto p-0 text-xs"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
      variant="link"
    >
      {label}
    </Button>
  );
}

function EventPicker({
  hasEvents,
  children,
}: {
  hasEvents: boolean;
  children: ReactNode;
}) {
  if (hasEvents) {
    return children;
  }

  return (
    <p className="text-muted-foreground text-xs">
      This server declares no Events. The host app passes Events to
      <code className="mx-1 font-mono text-xs">createWfGraphApp</code>. Declared
      Events appear in this list.
    </p>
  );
}

/** One Event row's own filter, absent for a collapsed group. */
type ChosenEventFilter = {
  model: string | undefined;
  onChange: (eventName: string, model: string | undefined) => void;
};

function ChosenEvent({
  eventName,
  label,
  role,
  request,
  catalog,
  filter,
  onCommitPath,
  onRemove,
  disabled,
}: {
  eventName: string;
  label: string | undefined;
  role: "start" | "cancel";
  request: CorrelationPathRequest | undefined;
  catalog: ExtensionCatalog;
  filter: ChosenEventFilter | undefined;
  onCommitPath: (eventName: string, path: string) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const displayName = label ?? eventName;
  // This Event alone, held stable because `LifecycleFilterEditor` memoizes a walk of
  // every node in the graph on it.
  const scope = useMemo(() => [eventName], [eventName]);

  return (
    <div className="rounded-md border">
      <div className="flex min-h-9 items-center justify-between gap-2 px-3 py-1.5">
        <h5
          className="min-w-0 truncate font-semibold text-base"
          title={displayName}
        >
          {displayName}
        </h5>
        <Button
          aria-label={`Remove ${eventName}`}
          className="shrink-0"
          disabled={disabled}
          onClick={() => {
            onRemove();
            toast("Event removed", {
              description: "Use Actions > Undo to restore it.",
            });
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {request || filter ? (
        <div className="space-y-2 border-t px-3 py-2">
          {request ? (
            <CorrelationPathInput
              catalog={catalog}
              disabled={disabled}
              onCommit={onCommitPath}
              request={request}
            />
          ) : null}
          {filter ? (
            <LifecycleFilterEditor
              actionName={`filter for ${displayName}`}
              disabled={disabled}
              eventNames={scope}
              model={filter.model}
              onChange={(model) => filter.onChange(eventName, model)}
              role={role}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Lifecycle Filter control, for one Event or for a group of them.
 *
 * The vocabulary is the difference between the two uses and the only one: a
 * filter written for one Event may read anything that Event declares, and one
 * standing for several may read only what they agree on. Everything else, what an
 * unfinished rule looks like, how a rule is added, how it reads once written, is
 * `ConditionBuilderRow`, which the Condition node and the Wait match also build
 * from.
 *
 * The stored value is the model alone, and `next.expression` is dropped: nothing
 * a Lifecycle Filter compares is known before an arrival, so delivery compiles the
 * model itself and a stored copy of the CEL could only go stale.
 */
function LifecycleFilterEditor({
  actionName,
  eventNames,
  model,
  onChange,
  disabled,
  role,
}: {
  /** The Edit and Done controls use this subject. */
  actionName: string;
  /**
   * The Events this filter is written against. One means a filter of its own,
   * several mean one control standing for the group. Held stable by its caller,
   * because the derivation below reads every node in the graph.
   */
  eventNames: readonly string[];
  model: string | undefined;
  onChange: (model: string | undefined) => void;
  disabled: boolean;
  role: "start" | "cancel";
}) {
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const shared = eventNames.length > 1;

  const fields: ConditionSelectableField[] = useMemo(
    () => getSharedEventConditionFields(catalog, eventNames, nodes),
    [catalog, eventNames, nodes]
  );

  /**
   * The fields a filter can actually compare a payload on.
   *
   * A shared filter is also offered the row naming the arriving Event, which is
   * not one of them: it says which Event this is rather than what its payload
   * carries. Seeding on it would open every shared filter as "Event name is
   * nothing", and counting it would claim a vocabulary where there is none.
   */
  const payloadFields = useMemo(
    () => fields.filter((field) => field.path !== EVENT_NAME_FIELD_PATH),
    [fields]
  );

  const handleChange = useCallback(
    (next: { model: string; expression: string }) => {
      onChange(next.model);
    },
    [onChange]
  );

  /**
   * Whether the rule below was seeded by the button rather than loaded with the
   * workflow, which is what opens the builder on its controls: one click for a
   * filter the builder still has to fill in, rather than a summary and an Edit.
   */
  const [seededHere, setSeededHere] = useState(false);

  const seedFilter = useCallback(() => {
    const seedField = payloadFields[0];
    if (!seedField) {
      return;
    }

    onChange(
      serializeConditionModel(
        seedConditionModelForField(seedField, {
          groupId: nanoid(),
          conditionId: nanoid(),
        })
      )
    );
    setSeededHere(true);
  }, [payloadFields, onChange]);

  if (!model) {
    return (
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">
          {shared
            ? role === "start"
              ? "Every arrival of these Events starts a run, whatever it carries."
              : "Every arrival of these Events cancels matching runs, whatever it carries."
            : role === "start"
              ? `Every ${eventNames[0]} arrival starts a run, whatever it carries.`
              : `Every ${eventNames[0]} arrival cancels matching runs, whatever it carries.`}
        </p>
        <Button
          disabled={disabled || payloadFields.length === 0}
          onClick={seedFilter}
          size="sm"
          type="button"
          variant="outline"
        >
          Add a filter
        </Button>
      </div>
    );
  }

  return (
    <ConditionBuilderRow
      defaultEditing={seededHere}
      description={
        shared
          ? role === "start"
            ? "An arrival that does not satisfy this starts no run. Only the fields every Start Event declares can be read here."
            : "An arrival that does not satisfy this cancels no runs. Only the fields every Cancel Event declares can be read here."
          : role === "start"
            ? "An arrival that does not satisfy this starts no run. Compare a payload field against a literal."
            : "An arrival that does not satisfy this cancels no runs. Compare a payload field against a literal."
      }
      disabled={disabled}
      editActionName={actionName}
      emptyFieldsMessage={
        shared
          ? role === "start"
            ? "These Events declare no fields in common, so there is nothing one filter can read. Filter each Event separately."
            : "These Events declare no fields in common, so there is nothing one filter can read. Filter each Cancel Event separately."
          : "This Event declares no fields, so there is nothing to filter on."
      }
      fields={fields}
      label="Filter"
      onChange={handleChange}
      value={model}
    />
  );
}

function CorrelationPathInput({
  request,
  catalog,
  disabled,
  onCommit,
}: {
  request: CorrelationPathRequest;
  catalog: ExtensionCatalog;
  disabled: boolean;
  onCommit: (eventName: string, path: string) => void;
}) {
  const inputId = useId();
  const { eventName, declaredPath, suppliedPath } = request;
  const paths = correlationPathChoices(
    catalog,
    eventName,
    declaredPath,
    suppliedPath
  );

  return (
    <div className="space-y-1">
      <Label className="text-muted-foreground text-xs" htmlFor={inputId}>
        Correlation Path
        <span className="sr-only">{` for ${eventName}`}</span>
      </Label>
      <Select
        disabled={disabled}
        items={[
          ...(declaredPath ? [] : [{ label: "Choose a path", value: null }]),
          ...paths.map((path) => ({ label: path, value: path })),
        ]}
        onValueChange={(next) =>
          onCommit(
            eventName,
            next === declaredPath || next === null ? "" : next
          )
        }
        value={suppliedPath ?? declaredPath ?? null}
      >
        <SelectTrigger className="w-full" id={inputId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {declaredPath ? null : (
            <SelectItem value={null}>Choose a path</SelectItem>
          )}
          {paths.map((path) => (
            <SelectItem key={path} value={path}>
              {path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const IDENTIFYING_FIELD_TYPES = new Set(["string", "number"]);

function correlationPathChoices(
  catalog: ExtensionCatalog,
  eventName: string,
  declaredPath: string | undefined,
  suppliedPath: string | undefined
): string[] {
  const offered = (findEvent(catalog, eventName)?.payloadFields ?? [])
    .filter((field) => IDENTIFYING_FIELD_TYPES.has(field.type ?? ""))
    .map((field) => field.path);

  return uniq(compact([...offered, declaredPath, suppliedPath]));
}
