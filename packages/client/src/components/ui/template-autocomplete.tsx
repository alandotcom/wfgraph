import { useAtom } from "jotai";
import { Check } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAfterCommit, useDomEvent } from "#src/hooks/effects";
import {
  getNodeDisplayName,
  getNodeOutputFields,
  getUpstreamNodes,
} from "#src/lib/upstream-node-fields";
import { edgesAtom, nodesAtom } from "#src/lib/workflow-graph-store";
import { cn } from "@rova/shared/utils";
import {
  formatTemplateToken,
  type ReferenceField,
} from "@rova/shared/workflow/node-references";

type TemplateAutocompleteProps = {
  isOpen: boolean;
  position: { top: number; left: number };
  onSelect: (template: string) => void;
  onClose: () => void;
  currentNodeId?: string;
  filter?: string;
  fieldType?: "duration" | "timestamp";
};

/**
 * Where a field sits in the menu for a typed target: the lower the rank, the
 * higher it appears.
 *
 * A rank rather than a verdict, because what a target accepts is wider than its
 * own type. A template renders to text and the parsers behind these fields read
 * more than one form: `parseTimestampWithTimezone` takes an ISO string or a unix
 * epoch, and a duration is written `24h` or `P1D`. Ranking is what keeps an
 * exactly-typed field at the top of the menu while leaving the rest reachable,
 * which matters most for a duration field, whose payload usually holds no number
 * at all.
 *
 * A field of no declared type ranks with the exact matches, because nothing is
 * known against it.
 */
function fieldRank(
  field: ReferenceField,
  targetType: "duration" | "timestamp" | undefined
): number {
  if (!(targetType && field.type)) {
    return 0;
  }

  if (targetType === "duration") {
    // A duration is a length. A timestamp names an instant, so it ranks with the
    // shapes that carry no length at all rather than with plain text.
    if (field.type === "number") {
      return 0;
    }
    return field.type === "string" ? 1 : 2;
  }

  if (field.type === "timestamp" || field.format === "timestamp") {
    return 0;
  }

  // A number is a unix epoch to the timestamp parser, which is one of the two
  // forms it reads, so it sits level with a string rather than below it.
  return field.type === "string" || field.type === "number" ? 1 : 2;
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
};

export function TemplateAutocomplete({
  isOpen,
  position,
  onSelect,
  onClose,
  currentNodeId,
  filter = "",
  fieldType,
}: TemplateAutocompleteProps) {
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

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
      const nodeName = getNodeDisplayName(node);

      if (!fieldType && node.data.type !== "trigger") {
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

      for (const field of getNodeOutputFields(node, {
        targetNodeId: currentNodeId,
        edges,
      })) {
        nextOptions.push({
          type: "field",
          rank: fieldRank(field, fieldType),
          nodeId: node.id,
          nodeName,
          field: field.path,
          description: field.description,
          template: formatTemplateToken({
            nodeId: node.id,
            nodeLabel: nodeName,
            fieldPath: field.path,
          }),
        });
      }
    }

    // A stable sort, so the fields a typed target actually wants come first while
    // each node's own fields stay in schema order behind them.
    return nextOptions.toSorted((a, b) => a.rank - b.rank);
  }, [upstreamNodes, fieldType, currentNodeId, edges]);

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

  // Handle keyboard navigation
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
        case "Enter":
          e.preventDefault();
          if (filteredOptions[selectedOptionIndex]) {
            onSelect(filteredOptions[selectedOptionIndex].template);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filteredOptions, selectedOptionIndex, onSelect, onClose]
  );

  useDomEvent(window, "keydown", handleKeyDown, { enabled: isOpen });

  // Keyboard navigation can walk the highlight past the edge of the scroll box,
  // and only the DOM knows where that edge is.
  useAfterCommit(selectedOptionIndex, () => {
    const selectedElement = menuRef.current?.children.item(selectedOptionIndex);
    if (selectedElement instanceof HTMLElement) {
      selectedElement.scrollIntoView({ block: "nearest" });
    }
  });

  if (
    !isOpen ||
    filteredOptions.length === 0 ||
    typeof document === "undefined"
  ) {
    return null;
  }

  // Ensure position is within viewport
  const adjustedPosition = {
    top: Math.min(position.top, window.innerHeight - 300), // Keep 300px from bottom
    left: Math.min(position.left, window.innerWidth - 320), // Keep menu (320px wide) within viewport
  };

  const menuContent = (
    <div
      className="fixed z-[9999] w-80 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      ref={menuRef}
      style={{
        top: `${adjustedPosition.top}px`,
        left: `${adjustedPosition.left}px`,
      }}
    >
      <div className="max-h-60 overflow-y-auto">
        {filteredOptions.map((option, index) => (
          <div
            className={cn(
              "flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm transition-colors",
              index === selectedOptionIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50"
            )}
            key={`${option.nodeId}-${option.field || "root"}`}
            onMouseDown={(event) => {
              // Select on pointer down so contentEditable inputs don't blur first.
              event.preventDefault();
              onSelect(option.template);
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
            </div>
            {index === selectedOptionIndex && <Check className="h-4 w-4" />}
          </div>
        ))}
      </div>
    </div>
  );

  // Use portal to render at document root to avoid clipping issues
  return createPortal(menuContent, document.body);
}
