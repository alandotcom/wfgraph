import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  parseTemplate,
  type TemplateToken,
} from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";
import { readConfigString } from "@wfgraph/shared/graph/node-config";

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
 *
 * A badge is one atomic unit, as wide as the raw token it stands for, with a
 * caret position at each of its two edges. Every offset this module takes or
 * returns counts in those units.
 */

export type BadgeEditorOptions = {
  catalog: ExtensionCatalog;
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

/** Half-open range of one badge, in the units `readText` produces. */
export type BadgeRange = { start: number; end: number };

/** Where the caret is and what it can act on, for a key handler above. */
export type CaretContext = {
  offset: number;
  /** False while the user has a range selected, which the keys leave alone. */
  collapsed: boolean;
  /** The badge ending at the caret, which Backspace removes. */
  badgeBefore: BadgeRange | null;
  /** The badge starting at the caret, which Delete removes. */
  badgeAfter: BadgeRange | null;
};

export type BadgeEditor = {
  /** Draw `text`, replacing whatever is there. */
  render(text: string, options: RenderOptions): void;
  /** Draw the same text again against a changed graph, for renamed nodes. */
  rerender(nodes: WorkflowNode[]): void;
  /** The raw template string the field currently holds. */
  readText(): string;
  /** Null when the selection is somewhere other than this field. */
  readCaret(): CaretContext | null;
  /** Offsets outside the text, and inside a badge, snap to the nearest edge. */
  setCaretOffset(offset: number): void;
  /** Insert at the caret, as the browser would for a paste. */
  insertText(text: string): boolean;
  insertLineBreak(): boolean;
};

/** Marks the prompt text shown in an empty, unfocused field. */
const PLACEHOLDER_ATTRIBUTE = "data-placeholder";

/** Marks the line an empty field shows its caret on. Not the user's text. */
const FILLER_ATTRIBUTE = "data-filler";

const LIVE_BADGE_CLASS = "template-reference";
const BROKEN_BADGE_CLASS = "template-reference template-reference--broken";

/**
 * Badge text for a token. The label baked into the token can be stale, so the
 * node's current label wins whenever the node is still around.
 */
function getDisplayTextForToken(
  token: TemplateToken,
  nodes: WorkflowNode[],
  catalog: ExtensionCatalog
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
      displayLabel = findAction(catalog, actionType)?.label;
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

/**
 * One stretch of the field, carrying the text it contributes and the offset it
 * starts at. A badge and a line break are single units; the empty text nodes
 * around them are units of their own, zero wide, and are the caret's only
 * foothold where two badges meet.
 */
type Unit =
  | { kind: "text"; node: Text; start: number; text: string }
  | { kind: "badge"; node: HTMLElement; start: number; text: string }
  | { kind: "break"; node: HTMLElement; start: number; text: string };

function unitEnd(unit: Unit): number {
  return unit.start + unit.text.length;
}

/**
 * The field's contents, in order, with a running offset.
 *
 * The one traversal every answer is derived from. A badge's own label is not the
 * field's text, so the walk stops at a badge rather than descending into it;
 * reading the label back would double-count it and leave the caret arithmetic
 * pointing inside a span the browser will not type into.
 */
function scanUnits(container: HTMLElement, multiline: boolean): Unit[] {
  const units: Unit[] = [];
  let start = 0;

  function push(unit: Unit) {
    units.push(unit);
    start += unit.text.length;
  }

  function visit(node: Node) {
    if (node instanceof Text) {
      push({ kind: "text", node, start, text: node.data });
      return;
    }

    if (!(node instanceof HTMLElement)) {
      return;
    }

    const template = templateOf(node);
    if (template !== null) {
      push({ kind: "badge", node, start, text: template });
      return;
    }

    if (
      node.hasAttribute(PLACEHOLDER_ATTRIBUTE) ||
      node.hasAttribute(FILLER_ATTRIBUTE)
    ) {
      return;
    }

    if (node.tagName === "BR") {
      push({ kind: "break", node, start, text: multiline ? "\n" : "" });
      return;
    }

    for (const child of Array.from(node.childNodes)) {
      visit(child);
    }
  }

  for (const child of Array.from(container.childNodes)) {
    visit(child);
  }

  return units;
}

/**
 * The raw template string a field holds: literals as typed, badges as the token
 * they stand for, line breaks as newlines. Placeholder text is not the user's
 * text and never appears.
 */
function readTextFrom(container: HTMLElement, multiline: boolean): string {
  return scanUnits(container, multiline)
    .map((unit) => unit.text)
    .join("");
}

export function createBadgeEditor(
  container: HTMLElement,
  options: BadgeEditorOptions
): BadgeEditor {
  const { catalog } = options;
  const multiline = options.multiline ?? false;
  let lastRenderOptions: RenderOptions = { focused: false, nodes: [] };

  function totalLength(units: Unit[]): number {
    const last = units.at(-1);
    return last ? unitEnd(last) : 0;
  }

  /**
   * Where a DOM point falls in the field's text.
   *
   * A point on an element names a child index rather than a character, which is
   * the shape a selection takes after the browser deletes a badge, so it
   * resolves to where the first unit at or after that child begins.
   */
  function offsetOfPoint(
    units: Unit[],
    node: Node,
    nodeOffset: number
  ): number {
    const textUnit = units.find(
      (unit) => unit.kind === "text" && unit.node === node
    );
    if (textUnit) {
      return textUnit.start + Math.min(nodeOffset, textUnit.text.length);
    }

    const enclosing = units.find(
      (unit) => unit.kind !== "text" && unit.node.contains(node)
    );
    if (enclosing) {
      return nodeOffset === 0 ? enclosing.start : unitEnd(enclosing);
    }

    if (node instanceof HTMLElement) {
      const children = Array.from(node.childNodes);
      for (const child of children.slice(nodeOffset)) {
        const following = units.find(
          (unit) => unit.node === child || child.contains(unit.node)
        );
        if (following) {
          return following.start;
        }
      }

      const last = units.findLast((unit) => node.contains(unit.node));
      return last ? unitEnd(last) : totalLength(units);
    }

    return totalLength(units);
  }

  function badgeAt(units: Unit[], edge: "end" | "start", offset: number) {
    const unit = units.find(
      (candidate) =>
        candidate.kind === "badge" &&
        (edge === "start" ? candidate.start : unitEnd(candidate)) === offset
    );
    return unit ? { end: unitEnd(unit), start: unit.start } : null;
  }

  function readCaret(): CaretContext | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.endContainer)) {
      return null;
    }

    const units = scanUnits(container, multiline);
    const offset = offsetOfPoint(units, range.endContainer, range.endOffset);

    return {
      badgeAfter: badgeAt(units, "start", offset),
      badgeBefore: badgeAt(units, "end", offset),
      collapsed: range.collapsed,
      offset,
    };
  }

  /** Focus without re-firing focus on an element that already has it. */
  function focusContainer() {
    if (document.activeElement !== container) {
      container.focus();
    }
  }

  /**
   * A text node the caret can occupy at `offset`.
   *
   * Only a text unit is eligible, and a badge's label is not one, so the caret
   * lands in editable content every time. The last unit spanning the offset
   * wins, which is the empty node `draw` leaves against each badge.
   */
  function caretPointAt(
    units: Unit[],
    offset: number
  ): { node: Text; offset: number } | null {
    const pierced = units.find(
      (unit) =>
        unit.kind === "badge" && offset > unit.start && offset < unitEnd(unit)
    );
    if (pierced) {
      return caretPointAt(units, pierced.start);
    }

    const spanning = units.findLast(
      (unit) =>
        unit.kind === "text" && unit.start <= offset && offset <= unitEnd(unit)
    );

    return spanning?.kind === "text"
      ? { node: spanning.node, offset: offset - spanning.start }
      : null;
  }

  function placeCaret(targetOffset: number) {
    const units = scanUnits(container, multiline);
    const offset = Math.max(0, Math.min(targetOffset, totalLength(units)));
    const point = caretPointAt(units, offset);

    if (!point) {
      focusContainer();
      return;
    }

    const range = document.createRange();
    const selection = window.getSelection();
    try {
      range.setStart(point.node, point.offset);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      focusContainer();
    } catch {
      // A stale node can survive the scan; focusing is still better than not.
      focusContainer();
    }
  }

  /** A caret needs a text node to sit in, and a badge or a break offers none. */
  function appendCaretStop() {
    container.appendChild(document.createTextNode(""));
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
        appendCaretStop();
        container.appendChild(document.createElement("br"));
        appendCaretStop();
      }
    });
  }

  function draw(text: string, renderOptions: RenderOptions) {
    lastRenderOptions = renderOptions;

    const caretOffset = renderOptions.focused
      ? (renderOptions.caretOffset ?? readCaret()?.offset ?? null)
      : null;

    container.innerHTML = "";

    if (!(text || renderOptions.focused)) {
      const placeholder = document.createElement("span");
      // Marked so `readText` can tell prompt text from anything the user typed.
      // Without it, focusing an empty field reads its own placeholder back as
      // the field's value.
      placeholder.setAttribute(PLACEHOLDER_ATTRIBUTE, "");
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
        renderOptions.nodes,
        catalog
      );
      appendCaretStop();
      container.appendChild(badge);
      appendCaretStop();
    }

    // An empty focused field still needs a line to show its caret on. The break
    // is marked so `scanUnits` passes over it rather than reading it as a
    // newline the user typed.
    if (!text) {
      const filler = document.createElement("br");
      filler.setAttribute(FILLER_ATTRIBUTE, "");
      appendCaretStop();
      container.appendChild(filler);
    }

    if (renderOptions.focused && caretOffset !== null) {
      placeCaret(caretOffset);
    }
  }

  return {
    render: draw,
    rerender(nodes: WorkflowNode[]) {
      // The text comes back out of the DOM rather than from a copy kept here.
      // A copy goes stale the moment an ordinary keystroke is drawn by the
      // browser instead of by this editor, which is most of them.
      draw(readTextFrom(container, multiline), {
        ...lastRenderOptions,
        nodes,
        caretOffset: undefined,
      });
    },
    readText: () => readTextFrom(container, multiline),
    readCaret,
    setCaretOffset: placeCaret,
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
      lineBreak.parentNode?.insertBefore(
        document.createTextNode(""),
        lineBreak
      );
      range.setStart(trailingText, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    },
  };
}
