import { useAtom } from "jotai";
import { Check } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  getNodeDisplayName,
  getNodeOutputFields,
  getUpstreamNodes,
  type SourcedField,
} from "#src/lib/upstream-node-fields";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { cn } from "@wfgraph/shared/utils";
import {
  formatTemplateToken,
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
  currentNodeId?: string;
  filter?: string;
  fieldType?: ValueTargetType;
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
  nodeId: string;
  nodeName: string;
  field?: string;
  description?: string;
  template: string;
  /** Why this row cannot be chosen, absent where it can. */
  unusable?: string;
  /** The Events reaching this node that leave the path out. */
  absentOn?: string[];
};

export function TemplateAutocomplete({
  isOpen,
  anchor,
  onSelect,
  onClose,
  currentNodeId,
  filter = "",
  fieldType,
}: TemplateAutocompleteProps) {
  const catalog = useExtensionCatalog();
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The scroll box, not the positioned wrapper around it: the rows are its
  // children, and indexing them is how a highlight below the fold is found.
  const optionListRef = useRef<HTMLDivElement>(null);

  const upstreamNodes = useMemo(() => {
    return getUpstreamNodes({
      currentNodeId,
      nodes,
      edges,
    });
  }, [currentNodeId, edges, nodes]);

  const options = useMemo<TemplateOption[]>(() => {
    // Nothing is upstream of nowhere: `getUpstreamNodes` already answers with an
    // empty list, and this is where the id becomes a string for the entry node's
    // answer, which names the node asking.
    if (!currentNodeId) {
      return [];
    }

    const nextOptions: TemplateOption[] = [];

    for (const node of upstreamNodes) {
      const nodeName = getNodeDisplayName(catalog, node);
      const outputFields = getNodeOutputFields(node, {
        targetNodeId: currentNodeId,
        nodes,
        edges,
        catalog,
      });

      // A whole node's output, for dropping a JSON blob into a text field. Only
      // where the node produces something: Condition and Event Split route a run
      // and declare no output, so the row would stand for the bookkeeping the
      // engine logged rather than for anything a builder wrote the node to get.
      if (!fieldType && node.data.type !== "lifecycle" && outputFields.length) {
        nextOptions.push({
          type: "node",
          rank: 0,
          nodeId: node.id,
          nodeName,
          template: formatTemplateToken({
            nodeId: node.id,
            nodeLabel: nodeName,
          }),
        });
      }

      for (const field of outputFields) {
        const unusable = unusableReason(field, fieldType);
        if (!(unusable || offeredFor(field, fieldType))) {
          continue;
        }

        nextOptions.push({
          type: "field",
          rank: fieldRank(field, fieldType, unusable),
          nodeId: node.id,
          nodeName,
          field: field.path,
          description: field.description,
          template: formatTemplateToken({
            nodeId: node.id,
            nodeLabel: nodeName,
            fieldPath: field.path,
          }),
          ...(unusable ? { unusable } : {}),
          ...(field.absentOn?.length ? { absentOn: field.absentOn } : {}),
        });
      }
    }

    // A stable sort, so the fields a typed target actually wants come first while
    // each node's own fields stay in schema order behind them.
    return nextOptions.toSorted((a, b) => a.rank - b.rank);
  }, [upstreamNodes, fieldType, currentNodeId, nodes, edges, catalog]);

  const filteredOptions = useMemo(() => {
    const trimmedFilter = filter.trim().toLowerCase();
    if (!trimmedFilter) {
      return options;
    }

    return options.filter(
      (opt) =>
        opt.nodeName.toLowerCase().includes(trimmedFilter) ||
        (opt.field && opt.field.toLowerCase().includes(trimmedFilter))
    );
  }, [filter, options]);

  const selectedOptionIndex =
    filteredOptions.length === 0
      ? 0
      : Math.min(selectedIndex, filteredOptions.length - 1);

  // A typed target whose menu is empty says so, because the reason is a fact
  // about the payloads rather than about what was typed: nothing upstream is a
  // length of time, or an instant. A menu with nothing to say stays closed.
  const emptyMessage =
    fieldType && options.length === 0
      ? fieldType === "duration"
        ? "No field upstream is a duration. Type a value like 24h."
        : "No field upstream is a date and time. Type one, like 2026-03-10T09:00:00Z."
      : null;

  const hasRowsToShow = filteredOptions.length > 0 || emptyMessage !== null;

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
    const selectedElement =
      optionListRef.current?.children.item(selectedOptionIndex);
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
      className="fixed z-50 w-80 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      data-side={placement.side}
      data-slot="template-autocomplete"
      style={{
        left: placement.left,
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
        {filteredOptions.map((option, index) => (
          <div
            className={cn(
              "flex items-center justify-between rounded px-2 py-1.5 text-sm transition-colors",
              option.unusable
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer",
              index === selectedOptionIndex
                ? "bg-accent text-accent-foreground"
                : !option.unusable && "hover:bg-accent/50"
            )}
            key={`${option.nodeId}-${option.field || "root"}`}
            onMouseDown={(event) => {
              // Select on pointer down so contentEditable inputs don't blur first.
              event.preventDefault();
              if (!option.unusable) {
                onSelect(option.template);
              }
            }}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <div className="flex-1">
              <div className="font-medium">
                {option.type === "node" ? (
                  option.nodeName
                ) : (
                  <>
                    <span className="text-muted-foreground">
                      {option.nodeName}.
                    </span>
                    {option.field}
                  </>
                )}
              </div>
              {option.description && (
                <div className="text-muted-foreground text-xs">
                  {option.description}
                </div>
              )}
              {option.absentOn && (
                <div className="text-warning text-xs dark:text-warning">
                  Absent on {option.absentOn.join(", ")}
                </div>
              )}
              {option.unusable && (
                <div className="text-muted-foreground text-xs">
                  {option.unusable}
                </div>
              )}
            </div>
            {index === selectedOptionIndex && !option.unusable && (
              <Check className="size-4" />
            )}
          </div>
        ))}
      </div>
    </div>
  );

  // Use portal to render at document root to avoid clipping issues
  return createPortal(menuContent, document.body);
}
