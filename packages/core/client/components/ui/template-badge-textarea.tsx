import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { nodesAtom } from "@/lib/workflow-graph-store";
import type { WorkflowNode } from "@/shared/workflow/types";
import { findActionById } from "@/plugins/registry";
import { cn } from "@/shared/utils";
import {
  findTemplateTokens,
  parseTemplate,
  type TemplateToken,
} from "@/shared/workflow/node-references";
import { TemplateAutocomplete } from "./template-autocomplete";

export interface TemplateBadgeTextareaProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  rows?: number;
  fieldType?: "duration" | "timestamp";
}

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

// A badge is only "live" while the node its token names is still on the canvas.
function doesNodeExist(
  token: TemplateToken,
  nodes: WorkflowNode[]
): boolean {
  return nodes.some((n) => n.id === token.nodeId);
}

/**
 * Badge text for a token. The label baked into the token can be stale, so the
 * node's current label wins whenever the node is still around.
 */
function getDisplayTextForToken(
  token: TemplateToken,
  nodes: WorkflowNode[]
): string {
  const storedText = token.fieldPath
    ? `${token.nodeLabel}.${token.fieldPath}`
    : token.nodeLabel;

  const node = nodes.find((n) => n.id === token.nodeId);
  if (!node) {
    return storedText;
  }

  // Display label: custom label > human-readable action label > stored label
  let displayLabel: string | undefined = node.data.label;
  if (!displayLabel && node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      const action = findActionById(actionType);
      displayLabel = action?.label;
    }
  }

  if (!displayLabel) {
    return storedText;
  }

  return token.fieldPath ? `${displayLabel}.${token.fieldPath}` : displayLabel;
}

function insertTextAtSelection(text: string): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);

  return true;
}

function insertLineBreakAtSelection(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const lineBreak = document.createElement("br");
  const trailingText = document.createTextNode("");
  range.insertNode(lineBreak);
  lineBreak.parentNode?.insertBefore(trailingText, lineBreak.nextSibling);
  range.setStart(trailingText, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);

  return true;
}

function addTextWithLineBreaks(container: HTMLElement, text: string): void {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line) {
      container.appendChild(document.createTextNode(line));
    }
    if (index < lines.length - 1) {
      container.appendChild(document.createElement("br"));
    }
  });
}

/**
 * A textarea component that renders template variables as styled badges
 * Converts {{@nodeId:DisplayName.field}} to badges showing "DisplayName.field"
 */
export function TemplateBadgeTextarea({
  value = "",
  onChange,
  placeholder,
  disabled,
  className,
  id,
  rows = 3,
  fieldType,
}: TemplateBadgeTextareaProps) {
  const [isFocused, setIsFocused] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState(value);
  const shouldUpdateDisplay = useRef(true);
  const nodes = useAtomValue(nodesAtom);
  const selectedNodeId = nodes.find((n) => n.selected)?.id;

  // Autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompletePosition, setAutocompletePosition] = useState({
    top: 0,
    left: 0,
  });
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [atSignPosition, setAtSignPosition] = useState<number | null>(null);
  const pendingCursorPosition = useRef<number | null>(null);
  const displayValue = isFocused ? internalValue : value;

  // Update display when nodes change (to reflect label updates)
  useEffect(() => {
    if (!isFocused && internalValue) {
      shouldUpdateDisplay.current = true;
    }
  }, [nodes, isFocused, internalValue]);

  // Save cursor position
  const saveCursorPosition = (): { offset: number } | null => {
    if (!contentRef.current) {
      return null;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(contentRef.current);
    preCaretRange.setEnd(range.endContainer, range.endOffset);

    // Calculate offset considering badges as single characters
    let offset = 0;
    const walker = document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );

    let node;
    let found = false;
    while ((node = walker.nextNode()) && !found) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node === range.endContainer) {
          offset += range.endOffset;
          found = true;
        } else {
          const textLength = (node.textContent || "").length;
          offset += textLength;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        const element = node;
        const template = element.getAttribute("data-template");
        if (template) {
          if (
            element.contains(range.endContainer) ||
            element === range.endContainer
          ) {
            offset += template.length;
            found = true;
          } else {
            offset += template.length;
          }
        } else if (element.tagName === "BR") {
          if (
            element === range.endContainer ||
            element.contains(range.endContainer)
          ) {
            found = true;
          } else {
            offset += 1; // Count line break as 1 character
          }
        }
      }
    }

    return { offset };
  };

  // Restore cursor position
  const restoreCursorPosition = (cursorPos: { offset: number } | null) => {
    if (!(contentRef.current && cursorPos)) {
      return;
    }

    let offset = 0;
    const walker = document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );

    let node;
    let targetNode: Node | null = null;
    let targetOffset = 0;

    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = (node.textContent || "").length;
        if (offset + textLength >= cursorPos.offset) {
          targetNode = node;
          targetOffset = cursorPos.offset - offset;
          break;
        }
        offset += textLength;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        const element = node;
        const template = element.getAttribute("data-template");
        if (template) {
          if (offset + template.length >= cursorPos.offset) {
            // Position cursor after the badge
            targetNode = element.nextSibling;
            targetOffset = 0;
            if (!targetNode && element.parentNode) {
              // If no next sibling, create a text node
              targetNode = document.createTextNode("");
              element.parentNode.appendChild(targetNode);
            }
            break;
          }
          offset += template.length;
        } else if (element.tagName === "BR") {
          if (offset + 1 >= cursorPos.offset) {
            // Position cursor after the BR
            targetNode = element.nextSibling;
            targetOffset = 0;
            if (!targetNode && element.parentNode) {
              targetNode = document.createTextNode("");
              element.parentNode.appendChild(targetNode);
            }
            break;
          }
          offset += 1;
        }
      }
    }

    if (targetNode) {
      const range = document.createRange();
      const selection = window.getSelection();
      try {
        range.setStart(
          targetNode,
          Math.min(targetOffset, targetNode.textContent?.length || 0)
        );
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        contentRef.current.focus();
      } catch {
        // If positioning fails, just focus the element
        contentRef.current.focus();
      }
    }
  };

  // Parse text and render with badges
  const updateDisplay = (nextText?: string) => {
    if (!(contentRef.current && shouldUpdateDisplay.current)) {
      return;
    }

    const container = contentRef.current;
    const text = (nextText ?? displayValue) || "";

    // Save cursor position before updating
    let cursorPos = isFocused ? saveCursorPosition() : null;

    // If we have a pending cursor position (from autocomplete), use that instead
    if (pendingCursorPosition.current !== null) {
      cursorPos = { offset: pendingCursorPosition.current };
      pendingCursorPosition.current = null;
    }

    // Clear current content
    container.innerHTML = "";

    if (!(text || isFocused)) {
      // Show placeholder
      container.innerHTML = `<span class="text-muted-foreground pointer-events-none">${placeholder || ""}</span>`;
      return;
    }

    // Every node reference becomes a badge; everything between stays plain text.
    for (const segment of parseTemplate(text)) {
      if (segment.kind === "literal") {
        addTextWithLineBreaks(container, segment.text);
        continue;
      }

      const badge = document.createElement("span");
      const nodeExists = doesNodeExist(segment.token, nodes);
      badge.className = nodeExists
        ? "inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400 font-mono text-xs border border-blue-500/20 mx-0.5"
        : "inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-red-600 dark:text-red-400 font-mono text-xs border border-red-500/20 mx-0.5";
      badge.contentEditable = "false";
      // The raw token is what `extractValue` reads back out of the DOM.
      badge.setAttribute("data-template", segment.token.raw);
      badge.textContent = getDisplayTextForToken(segment.token, nodes);
      container.appendChild(badge);
    }

    // If empty and focused, ensure we can type
    if (container.innerHTML === "" && isFocused) {
      container.innerHTML = "<br>";
    }

    shouldUpdateDisplay.current = false;

    // Restore cursor position after updating
    if (cursorPos) {
      // Use requestAnimationFrame to ensure DOM is fully updated
      requestAnimationFrame(() => restoreCursorPosition(cursorPos));
    }
  };

  // Extract plain text from content
  const extractValue = (): string => {
    if (!contentRef.current) {
      return "";
    }

    let result = "";
    const walker = document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );

    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        // Check if this text node is inside a badge element
        let parent = node.parentElement;
        let isInsideBadge = false;
        while (parent && parent !== contentRef.current) {
          if (parent.getAttribute("data-template")) {
            isInsideBadge = true;
            break;
          }
          parent = parent.parentElement;
        }

        // Only add text if it's NOT inside a badge
        if (!isInsideBadge) {
          result += node.textContent;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        const element = node;
        const template = element.getAttribute("data-template");
        if (template) {
          result += template;
        } else if (element.tagName === "BR") {
          result += "\n";
        }
      }
    }

    return result;
  };

  const handleInput = () => {
    // Extract the value from DOM
    const newValue = extractValue();

    // Check if the value has changed
    if (newValue === internalValue) {
      // No change, ignore (this can happen with badge clicks, etc)
      return;
    }

    // Count templates in old and new values
    const oldTemplates = findTemplateTokens(internalValue).length;
    const newTemplates = findTemplateTokens(newValue).length;

    if (newTemplates > oldTemplates) {
      // A new template was added, update display to show badge
      setInternalValue(newValue);
      onChange?.(newValue);
      shouldUpdateDisplay.current = true;
      setShowAutocomplete(false);

      // Call updateDisplay immediately to render badges
      requestAnimationFrame(() => updateDisplay());
      return;
    }

    if (newTemplates === oldTemplates && newTemplates > 0) {
      // Same number of templates, just typing around existing badges
      // DON'T update display, just update the value
      setInternalValue(newValue);
      onChange?.(newValue);
      // Don't trigger display update - this prevents cursor reset!

      // Check for @ sign to show autocomplete (moved here so it works with existing badges)
      const lastAtSign = newValue.lastIndexOf("@");

      if (lastAtSign !== -1) {
        const filter = newValue.slice(lastAtSign + 1);

        if (filter.includes(" ") || filter.includes("\n")) {
          setShowAutocomplete(false);
        } else {
          setAutocompleteFilter(filter);
          setAtSignPosition(lastAtSign);

          if (contentRef.current) {
            const textareaRect = contentRef.current.getBoundingClientRect();
            const position = {
              top: textareaRect.bottom + window.scrollY + 4,
              left: textareaRect.left + window.scrollX,
            };
            setAutocompletePosition(position);
          }
          setShowAutocomplete(true);
        }
      } else {
        setShowAutocomplete(false);
      }

      return;
    }

    if (newTemplates < oldTemplates) {
      // A template was removed (e.g., user deleted a badge or part of template text)
      setInternalValue(newValue);
      onChange?.(newValue);
      shouldUpdateDisplay.current = true;
      requestAnimationFrame(() => updateDisplay());
      return;
    }

    // Normal typing (no badges present)
    setInternalValue(newValue);
    onChange?.(newValue);

    // Check for @ sign to show autocomplete
    const lastAtSign = newValue.lastIndexOf("@");

    if (lastAtSign !== -1) {
      const filter = newValue.slice(lastAtSign + 1);

      if (filter.includes(" ") || filter.includes("\n")) {
        setShowAutocomplete(false);
      } else {
        setAutocompleteFilter(filter);
        setAtSignPosition(lastAtSign);

        if (contentRef.current) {
          const textareaRect = contentRef.current.getBoundingClientRect();
          const position = {
            top: textareaRect.bottom + window.scrollY + 4,
            left: textareaRect.left + window.scrollX,
          };
          setAutocompletePosition(position);
        }
        setShowAutocomplete(true);
      }
    } else {
      setShowAutocomplete(false);
    }
  };

  const handleAutocompleteSelect = (template: string) => {
    if (!contentRef.current || atSignPosition === null) {
      return;
    }

    // Get current text
    const currentText = extractValue();

    // Replace from @ position to end of filter with the template
    const beforeAt = currentText.slice(0, atSignPosition);
    const afterFilter = currentText.slice(
      atSignPosition + 1 + autocompleteFilter.length
    );
    const newText = beforeAt + template + afterFilter;

    // Calculate where cursor should be after the template (right after the badge)
    const targetCursorPosition = beforeAt.length + template.length;

    setInternalValue(newText);
    onChange?.(newText);
    shouldUpdateDisplay.current = true;

    setShowAutocomplete(false);
    setAtSignPosition(null);
    setIsFocused(true);

    // Set pending cursor position for the next update
    pendingCursorPosition.current = targetCursorPosition;

    // Keep focus for cursor restoration without re-triggering focus sync.
    if (document.activeElement !== contentRef.current) {
      contentRef.current.focus();
    }
    requestAnimationFrame(() => updateDisplay(newText));
  };

  const handleFocus = () => {
    if (pendingCursorPosition.current === null) {
      setInternalValue(value);
    }
    setIsFocused(true);
    shouldUpdateDisplay.current = true;
  };

  const handleBlur = () => {
    // Delay to allow autocomplete click to register
    setTimeout(() => {
      if (document.activeElement === contentRef.current) {
        return;
      }
      setIsFocused(false);
      // Don't extract value on blur - it's already in sync from handleInput
      // Just trigger a display update to ensure everything renders correctly
      shouldUpdateDisplay.current = true;
      setShowAutocomplete(false);
    }, 200);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (insertTextAtSelection(text)) {
      handleInput();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Enter key to insert line breaks
    if (e.key === "Enter") {
      e.preventDefault();
      if (insertLineBreakAtSelection()) {
        handleInput();
      }
    }
  };

  // Update display only when needed (not while typing)
  useEffect(() => {
    if (shouldUpdateDisplay.current) {
      updateDisplay();
    }
  });

  // Calculate min height based on rows
  const minHeight = `${rows * 1.5}rem`;

  return (
    <>
      <div
        className={cn(
          "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        style={{ minHeight }}
      >
        <div
          className="w-full whitespace-pre-wrap break-words outline-none"
          contentEditable={!disabled}
          id={id}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          ref={contentRef}
          role="textbox"
          suppressContentEditableWarning
        />
      </div>

      <TemplateAutocomplete
        currentNodeId={selectedNodeId || undefined}
        fieldType={fieldType}
        filter={autocompleteFilter}
        isOpen={showAutocomplete}
        onClose={() => setShowAutocomplete(false)}
        onSelect={handleAutocompleteSelect}
        position={autocompletePosition}
      />
    </>
  );
}
