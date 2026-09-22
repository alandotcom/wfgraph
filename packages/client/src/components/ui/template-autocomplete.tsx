import { sortBy } from "es-toolkit/array";
import { useAtomValue } from "jotai";
import { Check } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  getTrackedEntityStateSource,
  getNodeDisplayName,
  getNodeOutputFields,
  getUpstreamNodes,
  type SourcedField,
} from "#src/lib/upstream-node-fields";
import {
  collectOpenRecordKeys,
  keysForRecord,
} from "#src/lib/open-record-keys";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { cn } from "@wfgraph/shared/utils";
import type { WorkflowSchemaItemType } from "@wfgraph/shared/graph/schema-codec";
import {
  appendOutputPathKey,
  formatTemplateToken,
  referenceFieldLabel,
  type ReferenceField,
} from "@wfgraph/shared/graph/node-references";
import {
  targetAccepts,
  type ValueTargetType,
} from "@wfgraph/shared/graph/value-targets";
import {
  placeTemplateAutocomplete,
  type TemplateAutocompleteAnchor,
} from "./place-template-autocomplete";

type TemplateAutocompleteProps = {
  isOpen: boolean;
  anchor: TemplateAutocompleteAnchor;
  onSelect: (template: string) => void;
  onClose: () => void;
  rows: TemplateAutocompleteRows;
};

/** What the menu offers a typed target: the save's rule, without the numbers. */
function offeredFor(
  field: Pick<ReferenceField, "type">,
  targetType: ValueTargetType | undefined
): boolean {
  return targetAccepts(field, targetType, { allowNumber: false });
}

/** Where a field sits in the menu: exactly-typed, then untyped, then unusable. */
function fieldRank(
  field: Pick<ReferenceField, "type">,
  targetType: ValueTargetType | undefined,
  unusable: string | undefined
): number {
  if (unusable) {
    return 2;
  }

  return targetType && !field.type ? 1 : 0;
}

/**
 * Why a path cannot be dropped into a field, or undefined where it can.
 *
 * Shown only where splitting would yield a type this target accepts. A clash
 * between two types it refuses is advice a builder would follow to the same
 * refusal.
 */
function unusableReason(
  field: SourcedField,
  targetType: ValueTargetType | undefined
): string | undefined {
  const clash = field.typeClash;
  if (!clash) {
    return undefined;
  }

  if (targetType && !clash.types.some((type) => offeredFor({ type }, targetType))) {
    return undefined;
  }

  return `${clash.events.join(" and ")} type this differently. Add an Event Split above this node to use it.`;
}

/** One row of the menu: a whole node's output, or one path inside it. */
type TemplateOption = {
  type: "node" | "field";
  rank: number;
  /** Stable group identity. Labels are display text and can collide or change. */
  sourceKey: string;
  nodeId: string;
  nodeName: string;
  /** Stable identity carried by a virtual source such as tracked Entity State. */
  sourceType?: string | undefined;
  field?: string | undefined;
  label?: string | undefined;
  description?: string | undefined;
  template: string;
  /** Why this row cannot be chosen, absent where it can. */
  unusable?: string | undefined;
  /** The Events reaching this node that leave the path out. */
  absentOn?: string[] | undefined;
  /** Internal record metadata used to complete a key typed under an open record. */
  recordOnly?: boolean | undefined;
  /**
   * Set on an open record, such as Resend's email tags: the type a key under
   * `field` carries. `keyUnderOpenRecordOptions` turns it into a row.
   */
  valueType?: WorkflowSchemaItemType | undefined;
};

type TemplateOptionSource = {
  sourceKey: string;
  nodeName: string;
  options: TemplateOption[];
};

type TemplateOptionGroup = TemplateOptionSource & {
  /** Index of the first option in the menu's keyboard selection sequence. */
  startIndex: number;
};

function sourceKey(input: Pick<TemplateOption, "nodeId" | "sourceType">): string {
  return JSON.stringify([input.nodeId, input.sourceType ?? null]);
}

/**
 * Whether `query` names a key under this record's own path, and whether that
 * key is offered for `targetType`. Narrows `field` and `valueType` to defined
 * so the caller can read them without checking again.
 */
function namesKeyUnderOpenRecord(
  record: TemplateOption,
  query: string,
  targetType: ValueTargetType | undefined
): record is TemplateOption & {
  field: string;
  valueType: WorkflowSchemaItemType;
} {
  return (
    record.valueType !== undefined &&
    record.field !== undefined &&
    query.startsWith(`${record.field}.`) &&
    offeredFor({ type: record.valueType }, targetType) &&
    query.slice(record.field.length + 1).length > 0
  );
}

/**
 * The row for a key somebody typed under an open record, or nothing.
 *
 * A record's keys are invented by the payload, so the menu cannot list them all.
 * What it can do is recognise one the moment it is written: typing
 * `data.tags.order_id` finds every `data.tags` record and offers the full path,
 * which `resolveOutputPath` walks at run time the same way. The query is matched
 * against each record's own path, so it is the path alone rather than the node
 * name and the path together.
 */
function keyUnderOpenRecordOptions(
  options: readonly TemplateOption[],
  query: string,
  targetType: ValueTargetType | undefined
): TemplateOption[] {
  return options
    .filter((record) => namesKeyUnderOpenRecord(record, query, targetType))
    .map((record) => {
      const key = query.slice(record.field.length + 1);
      const fieldPath = appendOutputPathKey(record.field, key);
      return {
        type: "field",
        rank: fieldRank({ type: record.valueType }, targetType, undefined),
        sourceKey: record.sourceKey,
        nodeId: record.nodeId,
        nodeName: record.nodeName,
        sourceType: record.sourceType,
        field: fieldPath,
        template: formatTemplateToken({
          nodeId: record.nodeId,
          nodeLabel: record.nodeName,
          sourceType: record.sourceType,
          fieldPath,
        }),
      };
    });
}

/** The rows a template field's autocomplete menu offers, and whether it shows. */
export type TemplateAutocompleteRows = {
  groups: TemplateOptionGroup[];
  filteredOptions: TemplateOption[];
  emptyMessage: string | null;
  /**
   * Whether the menu has anything to draw. The menu and its key listener exist
   * only while this and the field's open state are both true.
   */
  hasRowsToShow: boolean;
};

/**
 * The autocomplete rows for one template field. The field calls this so it can
 * mark itself open on exactly the condition that draws the menu.
 */
export function useTemplateAutocompleteRows(input: {
  currentNodeId?: string | undefined;
  filter?: string | undefined;
  fieldType?: ValueTargetType | undefined;
}): TemplateAutocompleteRows {
  const { currentNodeId, filter = "", fieldType } = input;
  const catalog = useExtensionCatalog();
  const nodes = useAtomValue(nodesAtom);
  const edges = useAtomValue(edgesAtom);

  const upstreamNodes = useMemo(() => {
    return getUpstreamNodes({
      currentNodeId,
      nodes,
      edges,
    });
  }, [currentNodeId, edges, nodes]);

  const optionSources = useMemo<TemplateOptionSource[]>(() => {
    // Nothing is upstream of nowhere: `getUpstreamNodes` already answers with an
    // empty list, and this is where the id becomes a string for the entry node's
    // answer, which names the node asking.
    if (!currentNodeId) {
      return [];
    }

    const nextOptions: TemplateOption[] = [];
    const graphKeys = collectOpenRecordKeys(nodes, catalog);
    const entitySource = getTrackedEntityStateSource({ nodes, catalog });
    const sources = [
      ...upstreamNodes.map((node) => ({
        nodeId: node.id,
        nodeName: getNodeDisplayName(catalog, node),
        fields: getNodeOutputFields(node, {
          targetNodeId: currentNodeId,
          nodes,
          edges,
          catalog,
        }),
        sourceType: undefined as string | undefined,
        offersWholeOutput: node.data.type !== "lifecycle",
      })),
      ...(entitySource
        ? [
            {
              nodeId: entitySource.sourceId,
              nodeName: entitySource.sourceName,
              fields: entitySource.fields,
              sourceType: entitySource.sourceType,
              offersWholeOutput: false,
            },
          ]
        : []),
    ];

    for (const source of sources) {
      const {
        nodeId,
        nodeName,
        fields: outputFields,
        sourceType,
        offersWholeOutput,
      } = source;

      // A whole node's output, for dropping a JSON blob into a text field. A
      // virtual Entity source offers declared fields only, and the Lifecycle
      // node's whole payload remains unavailable.
      if (!fieldType && offersWholeOutput && outputFields.length) {
        nextOptions.push({
          type: "node",
          rank: 0,
          sourceKey: sourceKey(source),
          nodeId,
          nodeName,
          sourceType,
          template: formatTemplateToken({
            nodeId,
            nodeLabel: nodeName,
            sourceType,
          }),
        });
      }

      for (const field of outputFields) {
        const unusable = unusableReason(field, fieldType);
        if (unusable || offeredFor(field, fieldType)) {
          nextOptions.push({
            type: "field",
            rank: fieldRank(field, fieldType, unusable),
            sourceKey: sourceKey(source),
            nodeId,
            nodeName,
            sourceType,
            field: field.path,
            label: referenceFieldLabel(field),
            description: field.description,
            template: formatTemplateToken({
              nodeId,
              nodeLabel: nodeName,
              sourceType,
              fieldPath: field.path,
            }),
            unusable,
            absentOn: field.absentOn?.length ? field.absentOn : undefined,
            valueType: field.valueType,
          });
        }

        // A record's keys are judged on what a key carries, not on the record
        // being an object: a record of timestamps serves a Wait's date field
        // even though the record itself never could.
        const valueType = field.valueType;
        if (
          !valueType ||
          unusable ||
          !offeredFor({ type: valueType }, fieldType)
        ) {
          continue;
        }

        // The record itself is not a selectable value for a typed target, but it
        // remains in the option set as metadata so a key typed under this record
        // can produce one option for every upstream node that owns the record.
        nextOptions.push({
          type: "field",
          rank: fieldRank({ type: valueType }, fieldType, undefined),
          sourceKey: sourceKey(source),
          nodeId,
          nodeName,
          sourceType,
          field: field.path,
          template: formatTemplateToken({
            nodeId,
            nodeLabel: nodeName,
            sourceType,
            fieldPath: field.path,
          }),
          recordOnly: true,
          valueType,
        });

        // The keys this graph fills the record with, listed beside it. A Send
        // Email node tagged `name` is why `tags.name` is a row rather than
        // something a builder has to know to type.
        for (const key of keysForRecord(
          graphKeys,
          field.integration,
          field.path
        )) {
          const fieldPath = appendOutputPathKey(field.path, key);
          nextOptions.push({
            type: "field",
            rank: fieldRank({ type: valueType }, fieldType, undefined),
            sourceKey: sourceKey(source),
            nodeId,
            nodeName,
            sourceType,
            field: fieldPath,
            template: formatTemplateToken({
              nodeId,
              nodeLabel: nodeName,
              sourceType,
              fieldPath,
            }),
          });
        }
      }
    }

    // Keep sources in graph order. A stable sort inside each source puts
    // compatible fields first without disturbing their schema order.
    return [
      ...Map.groupBy(nextOptions, (option) => option.sourceKey),
    ].map(([groupSourceKey, groupOptions]) => ({
      sourceKey: groupSourceKey,
      nodeName: groupOptions[0]?.nodeName ?? "",
      options: sortBy(groupOptions, [(option) => option.rank]),
    }));
  }, [upstreamNodes, fieldType, currentNodeId, nodes, edges, catalog]);

  const groups = useMemo(() => {
    const trimmedFilter = filter.trim();
    const normalizedFilter = trimmedFilter.toLowerCase();
    let startIndex = 0;

    return optionSources.flatMap(
      ({ sourceKey: groupSourceKey, nodeName, options }): TemplateOptionGroup[] => {
        const visibleOptions = options.filter((option) => !option.recordOnly);
        const matched = normalizedFilter
          ? visibleOptions.filter((option) => {
              const fullPath = option.field
                ? `${option.nodeName}.${option.field}`
                : option.nodeName;
              return [
                option.nodeName,
                fullPath,
                option.label,
                option.description,
              ].some(
                (text) =>
                  text?.toLowerCase().includes(normalizedFilter) === true
              );
            })
          : visibleOptions;

        // Matched case-sensitively, because a record key is compared as written:
        // a tag named `orderId` is a different key from `orderid`. A key the
        // graph already named is in `matched`, and offering it twice would draw
        // two rows in the same source group.
        const typedKeys = normalizedFilter
          ? keyUnderOpenRecordOptions(options, trimmedFilter, fieldType).filter(
              (typedKey) =>
                !matched.some(
                  (row) =>
                    row.nodeId === typedKey.nodeId &&
                    row.field === typedKey.field
                )
            )
          : [];
        const filtered = normalizedFilter
          ? sortBy([...typedKeys, ...matched], [(option) => option.rank])
          : matched;
        if (filtered.length === 0) {
          return [];
        }

        const group = {
          sourceKey: groupSourceKey,
          nodeName,
          options: filtered,
          startIndex,
        };
        startIndex += filtered.length;
        return [group];
      }
    );
  }, [filter, optionSources, fieldType]);

  const filteredOptions = useMemo(
    () => groups.flatMap((group) => group.options),
    [groups]
  );

  // A typed target whose menu is empty says so, because the reason is a fact
  // about the payloads rather than about what was typed: nothing upstream is a
  // length of time, or an instant. A menu with nothing to say stays closed.
  const emptyMessage =
    fieldType && optionSources.length === 0
      ? fieldType === "duration"
        ? "No field upstream is a duration. Type a value like 24h."
        : "No field upstream is a date and time. Type one, like 2026-03-10T09:00:00Z."
      : null;

  const hasRowsToShow = filteredOptions.length > 0 || emptyMessage !== null;

  return { groups, filteredOptions, emptyMessage, hasRowsToShow };
}

export function TemplateAutocomplete({
  isOpen,
  anchor,
  onSelect,
  onClose,
  rows,
}: TemplateAutocompleteProps) {
  const { groups, filteredOptions, emptyMessage, hasRowsToShow } = rows;
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The scroll box, not the positioned wrapper around it. Group headings sit
  // between its options, so each option carries its flattened selection index.
  const optionListRef = useRef<HTMLDivElement>(null);

  const selectedOptionIndex =
    filteredOptions.length === 0
      ? 0
      : Math.min(selectedIndex, filteredOptions.length - 1);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredOptions.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter": {
          e.preventDefault();
          const option = filteredOptions[selectedOptionIndex];
          if (option && !option.unusable) {
            onSelect(option.template);
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filteredOptions, selectedOptionIndex, onSelect, onClose]
  );

  // Armed on exactly the condition that draws the menu below. A listener living
  // past that point takes the arrow and Escape keys from a field showing nothing.
  useDomEvent(window, "keydown", handleKeyDown, {
    enabled: isOpen && hasRowsToShow,
  });

  // Keyboard navigation can walk the highlight past the edge of the scroll box,
  // and only the DOM knows where that edge is.
  useAfterCommit(selectedOptionIndex, () => {
    const selectedElement = optionListRef.current?.querySelector(
      `[data-option-index="${selectedOptionIndex}"]`
    );
    if (selectedElement instanceof HTMLElement) {
      selectedElement.scrollIntoView({ block: "nearest" });
    }
  });

  if (!(isOpen && hasRowsToShow) || typeof document === "undefined") {
    return null;
  }

  const placement = placeTemplateAutocomplete(anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const menuContent = (
    <div
      className="fixed z-50 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      data-side={placement.side}
      data-slot="template-autocomplete"
      style={{
        left: placement.left,
        width: placement.width,
        ...(placement.side === "bottom"
          ? { top: placement.top }
          : { bottom: placement.bottom }),
      }}
    >
      <div
        className="overflow-y-auto"
        ref={optionListRef}
        style={{ maxHeight: placement.maxHeight }}
      >
        {emptyMessage && (
          <div className="px-2 py-1.5 text-muted-foreground text-sm">
            {emptyMessage}
          </div>
        )}
        {groups.map((group) => (
          <div
            data-slot="template-autocomplete-group"
            data-source-key={group.sourceKey}
            key={group.sourceKey}
          >
            <div
              className="truncate px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs"
              data-slot="template-autocomplete-heading"
              title={group.nodeName}
            >
              {group.nodeName}
            </div>
            {group.options.map((option, groupIndex) => {
              const index = group.startIndex + groupIndex;
              return (
                <div
                  className={cn(
                    "flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded px-2 py-1.5 text-sm transition-colors",
                    option.unusable
                      ? "cursor-not-allowed opacity-60"
                      : "cursor-pointer",
                    index === selectedOptionIndex
                      ? "bg-accent text-accent-foreground"
                      : !option.unusable && "hover:bg-accent/50"
                  )}
                  data-option-index={index}
                  data-slot="template-autocomplete-option"
                  key={`${option.sourceKey}-${option.field || "root"}`}
                  onMouseDown={(event) => {
                    // Select on pointer down so contentEditable inputs don't blur first.
                    event.preventDefault();
                    if (!option.unusable) {
                      onSelect(option.template);
                    }
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div className="truncate font-medium">
                      {option.type === "node"
                        ? "Entire output"
                        : referenceFieldLabel({
                            path: option.field ?? "",
                            label: option.label,
                          })}
                    </div>
                    {option.type === "field" ? (
                      <div
                        className="truncate font-mono text-muted-foreground text-xs"
                        title={option.field}
                      >
                        {option.field}
                      </div>
                    ) : null}
                    {option.description && (
                      <div className="break-words text-muted-foreground text-xs">
                        {option.description}
                      </div>
                    )}
                    {option.absentOn && (
                      <div className="break-words text-warning text-xs dark:text-warning">
                        Absent on {option.absentOn.join(", ")}
                      </div>
                    )}
                    {option.unusable && (
                      <div className="break-words text-muted-foreground text-xs">
                        {option.unusable}
                      </div>
                    )}
                  </div>
                  {index === selectedOptionIndex && !option.unusable && (
                    <Check className="size-4 shrink-0" />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  // Use portal to render at document root to avoid clipping issues
  return createPortal(menuContent, document.body);
}
