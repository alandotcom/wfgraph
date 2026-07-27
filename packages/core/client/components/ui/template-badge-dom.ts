import { findActionById } from "@/plugins/registry";
import { parseTemplate, type TemplateToken } from "@/shared/workflow/node-references";
import type { WorkflowNode } from "@/shared/workflow/types";

/**
 * The contentEditable behind the template fields, as plain DOM.
 *
 * A contentEditable div is an uncontrolled widget: the browser owns its
 * children and its selection, and React must not try to own them too. So this
 * module has no React in it. The components above install an editor once, and
 * from then on every change goes through a method call in the event handler
 * that caused it, which is where imperative DOM work belongs.
 *
 * The text this editor holds is the raw template string, with node references
 * written as `{{@nodeId:Label.field}}`. Each reference is drawn as a badge whose
 * `data-template` attribute keeps the raw token, so reading the field back
 * yields the token and not the label the user can see. A badge shows the node's
 * *current* label, which is why renaming a node has to redraw them.
 */

export type BadgeEditorOptions = {
  /** Render newlines as `<br>` and allow inserting them. */
  multiline?: boolean;
};

export type RenderOptions = {
  /**
   * The graph as it stands, for resolving each badge's label and deciding
   * whether the node it names still exists. Passed in rather than read from a
   * getter so the editor holds no live reference back into React state.
   */
  nodes: WorkflowNode[];
  /** A focused field shows a caret rather than placeholder text. */
  focused: boolean;
  placeholder?: string;
  /**
   * Where to leave the caret afterwards, counted in the same units `readText`
   * produces: a badge is as long as the raw token it stands for. Omitted means
   * "wherever it is now", which is what an ordinary redraw wants.
   */
  caretOffset?: number;
};

export type BadgeEditor = {
  /** Draw `text`, replacing whatever is there. */
  render(text: string, options: RenderOptions): void;
  /** Draw the same text again against a changed graph, for renamed nodes. */
  rerender(nodes: WorkflowNode[]): void;
  /** The raw template string the field currently holds. */
  readText(): string;
  /** Insert at the caret, as the browser would for a paste. */
  insertText(text: string): boolean;
  insertLineBreak(): boolean;
};

const LIVE_BADGE_CLASS =
  "inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400 font-mono text-xs border border-blue-500/20 mx-0.5";
const BROKEN_BADGE_CLASS =
  "inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-red-600 dark:text-red-400 font-mono text-xs border border-red-500/20 mx-0.5";

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
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

  const node = nodes.find((candidate) => candidate.id === token.nodeId);
  if (!node) {
    return storedText;
  }

  // Display label: custom label > human-readable action label > stored label
  let displayLabel: string | undefined = node.data.label;
  if (!displayLabel && node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      displayLabel = findActionById(actionType)?.label;
    }
  }

  if (!displayLabel) {
    return storedText;
  }

  return token.fieldPath ? `${displayLabel}.${token.fieldPath}` : displayLabel;
}

/** The raw token a badge stands for, or null for anything that is not a badge. */
function templateOf(node: Node): string | null {
  return node instanceof HTMLElement
    ? node.getAttribute("data-template")
    : null;
}

export function createBadgeEditor(
  container: HTMLElement,
  options: BadgeEditorOptions = {}
): BadgeEditor {
  const multiline = options.multiline ?? false;
  let lastText = "";
  let lastRenderOptions: RenderOptions = { focused: false, nodes: [] };

  function walk(): TreeWalker {
    return document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );
  }

  function isLineBreak(node: Node): boolean {
    return multiline && node instanceof HTMLElement && node.tagName === "BR";
  }

  /** The caret's position, counting a badge as its whole raw token. */
  function readCaretOffset(): number | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const walker = walk();
    let offset = 0;
    let node = walker.nextNode();

    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node === range.endContainer) {
          return offset + range.endOffset;
        }
        offset += (node.textContent || "").length;
      } else {
        const template = templateOf(node);
        if (template) {
          const reached =
            node === range.endContainer ||
            (node instanceof HTMLElement && node.contains(range.endContainer));
          offset += template.length;
          if (reached) {
            return offset;
          }
        } else if (isLineBreak(node)) {
          const reached =
            node === range.endContainer ||
            (node instanceof HTMLElement && node.contains(range.endContainer));
          if (reached) {
            return offset;
          }
          offset += 1;
        }
      }
      node = walker.nextNode();
    }

    return offset;
  }

    /** Focus without re-firing focus on an element that already has it. */
  function focusContainer() {
    if (document.activeElement !== container) {
      container.focus();
    }
  }

  function placeCaret(targetOffset: number) {
    const walker = walk();
    let offset = 0;
    let target: Node | null = null;
    let withinTarget = 0;
    let node = walker.nextNode();

    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = (node.textContent || "").length;
        if (offset + length >= targetOffset) {
          target = node;
          withinTarget = targetOffset - offset;
          break;
        }
        offset += length;
      } else {
        const template = templateOf(node);
        const width = template ? template.length : isLineBreak(node) ? 1 : 0;
        if (width > 0 && offset + width >= targetOffset) {
          // A badge is atomic, so the caret goes after it rather than inside.
          target = node.nextSibling;
          withinTarget = 0;
          if (!target && node.parentNode) {
            target = document.createTextNode("");
            node.parentNode.appendChild(target);
          }
          break;
        }
        offset += width;
      }
      node = walker.nextNode();
    }

    if (!target) {
      focusContainer();
      return;
    }

    const range = document.createRange();
    const selection = window.getSelection();
    try {
      range.setStart(
        target,
        Math.min(withinTarget, target.textContent?.length || 0)
      );
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      focusContainer();
    } catch {
      // A stale node can survive the walk; focusing is still better than not.
      focusContainer();
    }
  }

  function appendLiteral(text: string) {
    if (!multiline) {
      container.appendChild(document.createTextNode(text));
      return;
    }

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

  function draw(text: string, renderOptions: RenderOptions) {
    lastText = text;
    lastRenderOptions = renderOptions;

    const caretOffset = renderOptions.caretOffset ?? readCaretOffset();

    container.innerHTML = "";

    if (!(text || renderOptions.focused)) {
      const placeholder = document.createElement("span");
      placeholder.className = "text-muted-foreground pointer-events-none";
      placeholder.textContent = renderOptions.placeholder ?? "";
      container.appendChild(placeholder);
      return;
    }

    for (const segment of parseTemplate(text)) {
      if (segment.kind === "literal") {
        appendLiteral(segment.text);
        continue;
      }

      const badge = document.createElement("span");
      const nodeExists = renderOptions.nodes.some(
        (node) => node.id === segment.token.nodeId
      );
      badge.className = nodeExists ? LIVE_BADGE_CLASS : BROKEN_BADGE_CLASS;
      badge.contentEditable = "false";
      // The raw token is what `readText` reads back out of the DOM.
      badge.setAttribute("data-template", segment.token.raw);
      badge.textContent = getDisplayTextForToken(
        segment.token,
        renderOptions.nodes
      );
      container.appendChild(badge);
    }

    // An empty focused field still needs somewhere to put the caret.
    if (container.innerHTML === "" && renderOptions.focused) {
      container.appendChild(document.createElement("br"));
    }

    if (renderOptions.focused && caretOffset !== null) {
      placeCaret(caretOffset);
    }
  }

  return {
    render: draw,
    rerender(nodes: WorkflowNode[]) {
      draw(lastText, { ...lastRenderOptions, nodes, caretOffset: undefined });
    },
    readText() {
      const walker = walk();
      let result = "";
      let node = walker.nextNode();

      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          // Text inside a badge is the label, which the token already carries.
          let parent = node.parentElement;
          let insideBadge = false;
          while (parent && parent !== container) {
            if (parent.getAttribute("data-template")) {
              insideBadge = true;
              break;
            }
            parent = parent.parentElement;
          }
          if (!insideBadge) {
            result += node.textContent;
          }
        } else {
          const template = templateOf(node);
          if (template) {
            result += template;
          } else if (isLineBreak(node)) {
            result += "\n";
          }
        }
        node = walker.nextNode();
      }

      return result;
    },
    insertText(text: string) {
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
    },
    insertLineBreak() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return false;
      }

      const range = selection.getRangeAt(0);
      range.deleteContents();
      const lineBreak = document.createElement("br");
      // A trailing text node gives the caret somewhere to land after the break.
      const trailingText = document.createTextNode("");
      range.insertNode(lineBreak);
      lineBreak.parentNode?.insertBefore(trailingText, lineBreak.nextSibling);
      range.setStart(trailingText, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    },
  };
}
