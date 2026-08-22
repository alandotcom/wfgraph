import { afterEach, describe, expect, it, vi } from "vitest";
import { type ReactElement } from "react";
import { fireEvent, render } from "@testing-library/react";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { ExtensionCatalogProvider } from "#src/components/extension-catalog-provider";
import { TemplateBadgeInput } from "./template-badge-input";
import { TemplateBadgeTextarea } from "./template-badge-textarea";
import { type BadgeEditor, createBadgeEditor } from "./template-badge-dom";

/**
 * Where the caret may sit and what the keys beside a badge do.
 *
 * The badges are drawn as `contenteditable="false"` spans, so a caret that lands
 * inside one leaves the field taking no keystrokes at all. These cases stand on
 * the editor's own API rather than on typing, because happy-dom implements
 * `Selection` and `Range` but does no contentEditable editing of its own.
 */

const TOKEN_A = "{{@lifecycle_1:Webhook.occurredAt}}";
const TOKEN_B = "{{@action_1:Send Message.status}}";

/**
 * Every shape that has bitten: a leading badge with nothing before it, prose
 * between badges, two badges with no gap, and a trailing literal.
 */
const MIXED = `${TOKEN_A} hi ${TOKEN_A}${TOKEN_B} bye`;

function renderWithCatalog(ui: ReactElement) {
  return render(
    <ExtensionCatalogProvider value={emptyExtensionCatalog}>
      {ui}
    </ExtensionCatalogProvider>
  );
}

let container: HTMLElement | null = null;

function editorWith(
  text: string,
  options: { multiline?: boolean } = {}
): BadgeEditor {
  container = document.createElement("div");
  container.contentEditable = "true";
  document.body.appendChild(container);

  const editor = createBadgeEditor(container, {
    catalog: emptyExtensionCatalog,
    ...options,
  });
  // No node array: a token whose node is missing keeps the label baked into it,
  // which is a different length from the raw token and so exercises the offset
  // maths the same way a live badge does.
  editor.render(text, { focused: true, nodes: [] });
  return editor;
}

/**
 * The offsets a caret can hold. A badge is one atomic unit, so its two edges are
 * addressable and the raw token's interior is not.
 */
function caretLegalOffsets(value: string): number[] {
  const tokens = findTemplateTokens(value);
  const offsets: number[] = [];

  for (let offset = 0; offset <= value.length; offset++) {
    const interior = tokens.some(
      (token) => offset > token.start && offset < token.end
    );
    if (!interior) {
      offsets.push(offset);
    }
  }

  return offsets;
}

/** The badge a DOM node sits inside, or null when it sits in editable text. */
function enclosingBadge(node: Node | null | undefined): HTMLElement | null {
  let current = node instanceof HTMLElement ? node : node?.parentElement;

  while (current) {
    if (current.hasAttribute("data-template")) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function caretNode(): Node {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error("The editor left no selection behind");
  }
  return selection.getRangeAt(0).startContainer;
}

afterEach(() => {
  container?.remove();
  container = null;
});

describe("caret positions", () => {
  it("reads back the offset it was given, at every position a caret can hold", () => {
    const editor = editorWith(MIXED);

    for (const offset of caretLegalOffsets(MIXED)) {
      editor.setCaretOffset(offset);
      expect(editor.readCaret()?.offset).toBe(offset);
    }
  });

  it("keeps the caret out of every badge", () => {
    const editor = editorWith(MIXED);

    for (const offset of caretLegalOffsets(MIXED)) {
      editor.setCaretOffset(offset);
      expect(enclosingBadge(caretNode())).toBeNull();
    }
  });

  it("holds a caret on both sides of a badge that stands alone", () => {
    const editor = editorWith(TOKEN_A);

    editor.setCaretOffset(0);
    expect(editor.readCaret()?.offset).toBe(0);
    expect(enclosingBadge(caretNode())).toBeNull();

    editor.setCaretOffset(TOKEN_A.length);
    expect(editor.readCaret()?.offset).toBe(TOKEN_A.length);
    expect(enclosingBadge(caretNode())).toBeNull();
  });

  it("names the badge on each side of the caret", () => {
    const editor = editorWith(MIXED);
    const secondBadgeStart = `${TOKEN_A} hi `.length;

    editor.setCaretOffset(secondBadgeStart);
    expect(editor.readCaret()).toMatchObject({
      badgeAfter: {
        start: secondBadgeStart,
        end: secondBadgeStart + TOKEN_A.length,
      },
      badgeBefore: null,
      offset: secondBadgeStart,
    });

    editor.setCaretOffset(TOKEN_A.length);
    expect(editor.readCaret()).toMatchObject({
      badgeAfter: null,
      badgeBefore: { end: TOKEN_A.length, start: 0 },
    });
  });

  it("reports no badge beside a caret sitting in prose", () => {
    const editor = editorWith(MIXED);

    editor.setCaretOffset(`${TOKEN_A} h`.length);
    expect(editor.readCaret()).toMatchObject({
      badgeAfter: null,
      badgeBefore: null,
    });
  });

  it("counts a line break as one unit", () => {
    const value = `${TOKEN_A}\nafter`;
    const editor = editorWith(value, { multiline: true });

    expect(editor.readText()).toBe(value);

    for (const offset of caretLegalOffsets(value)) {
      editor.setCaretOffset(offset);
      expect(editor.readCaret()?.offset).toBe(offset);
    }
  });
});

function findTextbox(root: HTMLElement): HTMLElement {
  const textbox = root.querySelector("[role='textbox']");
  if (!(textbox instanceof HTMLElement)) {
    throw new Error("Failed to find the field");
  }
  return textbox;
}

function findBadge(textbox: HTMLElement, index: number): HTMLElement {
  const badge = textbox.querySelectorAll("[data-template]")[index];
  if (!(badge instanceof HTMLElement)) {
    throw new Error(`Failed to find badge ${index}`);
  }
  return badge;
}

/**
 * Put the caret against a badge the way a click would, by naming a DOM node
 * rather than an offset, so these cases stay independent of the offset maths.
 */
function putCaretBeside(badge: HTMLElement, side: "after" | "before") {
  const node = side === "after" ? badge.nextSibling : badge.previousSibling;
  if (!node) {
    throw new Error(`The badge has no ${side} sibling to hold a caret`);
  }

  const range = document.createRange();
  range.setStart(node, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** True where the caret sits earlier in the field than `node`. */
function caretPrecedes(node: Node): boolean {
  const position = caretNode().compareDocumentPosition(node);
  return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("keys beside a badge", () => {
  it("removes the whole badge on one Backspace", () => {
    const onChange = vi.fn();
    const { container: root } = renderWithCatalog(
      <TemplateBadgeInput onChange={onChange} value={`${TOKEN_A} tail`} />
    );
    const textbox = findTextbox(root);

    putCaretBeside(findBadge(textbox, 0), "after");
    expect(fireEvent.keyDown(textbox, { key: "Backspace" })).toBe(false);

    expect(onChange).toHaveBeenCalledWith(" tail");
    expect(textbox.querySelectorAll("[data-template]")).toHaveLength(0);
  });

  it("removes the whole badge on one Delete", () => {
    const onChange = vi.fn();
    const { container: root } = renderWithCatalog(
      <TemplateBadgeInput onChange={onChange} value={`lead ${TOKEN_A}`} />
    );
    const textbox = findTextbox(root);

    putCaretBeside(findBadge(textbox, 0), "before");
    expect(fireEvent.keyDown(textbox, { key: "Delete" })).toBe(false);

    expect(onChange).toHaveBeenCalledWith("lead ");
  });

  it("removes only the badge the caret touches", () => {
    const onChange = vi.fn();
    const { container: root } = renderWithCatalog(
      <TemplateBadgeInput onChange={onChange} value={`${TOKEN_A}${TOKEN_B}`} />
    );
    const textbox = findTextbox(root);

    putCaretBeside(findBadge(textbox, 0), "after");
    fireEvent.keyDown(textbox, { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith(TOKEN_B);
  });

  it("leaves Backspace in prose to the browser", () => {
    const onChange = vi.fn();
    const { container: root } = renderWithCatalog(
      <TemplateBadgeInput onChange={onChange} value={`${TOKEN_A} tail`} />
    );
    const textbox = findTextbox(root);
    const tail = findBadge(textbox, 0).nextSibling?.nextSibling;
    if (!tail) {
      throw new Error("Failed to find the text after the badge");
    }

    const range = document.createRange();
    range.setStart(tail, 3);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(fireEvent.keyDown(textbox, { key: "Backspace" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps over a badge in one press of an arrow", () => {
    const { container: root } = renderWithCatalog(
      <TemplateBadgeInput value={`${TOKEN_A} tail`} />
    );
    const textbox = findTextbox(root);
    const badge = findBadge(textbox, 0);

    putCaretBeside(badge, "after");
    expect(fireEvent.keyDown(textbox, { key: "ArrowLeft" })).toBe(false);
    expect(caretPrecedes(badge)).toBe(true);

    expect(fireEvent.keyDown(textbox, { key: "ArrowRight" })).toBe(false);
    expect(caretPrecedes(badge)).toBe(false);
  });

  it("keeps the caret out of a badge when a redraw restores it", () => {
    const { container: root } = renderWithCatalog(
      <TemplateBadgeInput
        onChange={() => {}}
        value={`${TOKEN_A} hi ${TOKEN_B}`}
      />
    );
    const textbox = findTextbox(root);
    const first = findBadge(textbox, 0);

    // A redraw only happens when the number of badges changes, which is when
    // the caret has to be read out of the old DOM and put back into the new.
    putCaretBeside(first, "after");
    findBadge(textbox, 1).remove();
    fireEvent.input(textbox);

    expect(enclosingBadge(caretNode())).toBeNull();
    expect(caretPrecedes(findBadge(textbox, 0))).toBe(false);
  });

  it("keeps Enter inserting a line break in the multi-line field", () => {
    const onChange = vi.fn();
    const { container: root } = renderWithCatalog(
      <TemplateBadgeTextarea onChange={onChange} value="one" />
    );
    const textbox = findTextbox(root);
    const line = textbox.firstChild;
    if (!line) {
      throw new Error("Failed to find the typed line");
    }

    const range = document.createRange();
    range.setStart(line, 3);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(fireEvent.keyDown(textbox, { key: "Enter" })).toBe(false);
    expect(onChange).toHaveBeenCalledWith("one\n");
  });
});
