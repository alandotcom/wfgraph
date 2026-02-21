import { useAtom } from "jotai";
import { Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { edgesAtom, nodesAtom } from "@/client/lib/workflow-store";
import {
  getNodeDisplayName,
  getNodeOutputFields,
  getUpstreamNodes,
} from "@/client/lib/upstream-node-fields";
import { cn } from "@/shared/utils";

type TemplateAutocompleteProps = {
  isOpen: boolean;
  position: { top: number; left: number };
  onSelect: (template: string) => void;
  onClose: () => void;
  currentNodeId?: string;
  filter?: string;
  fieldType?: "duration" | "timestamp";
};

type AutocompleteField = {
  field: string;
  description: string;
  fieldType?: string;
  fieldFormat?: "timestamp";
};

function isFieldCompatible(
  field: AutocompleteField,
  targetType: "duration" | "timestamp" | undefined
): boolean {
  if (!targetType) return true;
  if (!field.fieldType) return true;

  if (targetType === "duration") {
    return field.fieldType === "number";
  }

  if (targetType === "timestamp") {
    return (
      field.fieldType === "timestamp" || field.fieldFormat === "timestamp"
    );
  }

  return true;
}

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

  const options = useMemo<
    Array<{
      type: "node" | "field";
      nodeId: string;
      nodeName: string;
      field?: string;
      description?: string;
      template: string;
    }>
  >(() => {
    const nextOptions: Array<{
      type: "node" | "field";
      nodeId: string;
      nodeName: string;
      field?: string;
      description?: string;
      template: string;
    }> = [];

    for (const node of upstreamNodes) {
      const nodeName = getNodeDisplayName(node);
      const fields: AutocompleteField[] = getNodeOutputFields(node);

      if (!fieldType && node.data.type !== "trigger") {
        nextOptions.push({
          type: "node",
          nodeId: node.id,
          nodeName,
          template: `{{@${node.id}:${nodeName}}}`,
        });
      }

      for (const field of fields) {
        if (!isFieldCompatible(field, fieldType)) continue;
        nextOptions.push({
          type: "field",
          nodeId: node.id,
          nodeName,
          field: field.field,
          description: field.description,
          template: `{{@${node.id}:${nodeName}.${field.field}}}`,
        });
      }
    }

    return nextOptions;
  }, [upstreamNodes, fieldType]);

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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

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
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredOptions, selectedOptionIndex, onSelect, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (menuRef.current) {
      const selectedElement = menuRef.current.children.item(selectedOptionIndex);
      if (selectedElement instanceof HTMLElement) {
        selectedElement.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedOptionIndex]);

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
