import { useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { useAfterCommit } from "#src/hooks/effects";
import { nodesAtom } from "#src/lib/workflow-graph-store";
import { findTemplateTokens } from "@rova/shared/graph/node-references";
import {
  type BadgeEditor,
  createBadgeEditor,
} from "./template-badge-dom";

/**
 * Everything the single-line and multi-line template fields share: the editor,
 * the autocomplete state, and the handlers that drive both.
 *
 * The two components were near-identical for about 250 lines, and each carried
 * four pieces of hidden state to schedule DOM work for later: a mirror of the
 * value, a "should redraw" flag, a pending caret position, and an effect with
 * no dependency array that ran after every render to act on the flag. None of
 * that survives, because the handler that changes the text now redraws it on
 * the spot; the caret position is an argument rather than a stashed ref.
 *
 * Two things still reach the DOM from React, because neither has a DOM event to
 * hang off: the parent supplying a different value while the user is elsewhere,
 * and a node being renamed so the badge labels change under the field.
 */
export function useTemplateBadgeField(input: {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const { value, onChange, placeholder, multiline } = input;

  const nodes = useAtomValue(nodesAtom);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<BadgeEditor | null>(null);
  // The text the field is known to hold. Compared against what the DOM reads
  // back, to tell a real edit from an input event that changed nothing, and to
  // tell whether the number of badges changed.
  const knownTextRef = useRef(value);

  const [isFocused, setIsFocused] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompletePosition, setAutocompletePosition] = useState({
    top: 0,
    left: 0,
  });
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [atSignPosition, setAtSignPosition] = useState<number | null>(null);

  const attachEditor = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element;
      if (!element) {
        editorRef.current = null;
        return;
      }
      // Installing the editor is all this does. The first draw comes from the
      // hook below, which fires on mount as well as on every later change, so
      // there is one place that decides what the DOM should say.
      editorRef.current = createBadgeEditor(element, { multiline });
    },
    [multiline]
  );

  // The parent handed over different text while the user was somewhere else.
  // While the field is focused the key is frozen, because the handlers below
  // are already keeping the DOM current and a redraw would fight the caret.
  useAfterCommit(isFocused ? FOCUSED : value, () => {
    if (!isFocused) {
      editorRef.current?.render(value, {
        focused: false,
        nodes,
        placeholder,
      });
    }
  });

  // Badge labels follow node labels. A rename produces no DOM event, so this is
  // the one genuine render-to-DOM sync left in these components.
  //
  // Not while the field has focus: the field's own edits flow back out through
  // onChange and land on a node, so every keystroke produces a new node array,
  // and rebuilding the DOM under a caret on every keystroke is exactly what the
  // machinery this replaced existed to avoid.
  useAfterCommit(isFocused ? FOCUSED : nodes, () => {
    if (!isFocused) {
      editorRef.current?.rerender(nodes);
    }
  });

  /** Show or hide the autocomplete based on a trailing `@word`. */
  const syncAutocomplete = useCallback((text: string) => {
    const lastAtSign = text.lastIndexOf("@");
    const filter = lastAtSign === -1 ? null : text.slice(lastAtSign + 1);

    if (filter === null || filter.includes(" ")) {
      setShowAutocomplete(false);
      return;
    }

    setAutocompleteFilter(filter);
    setAtSignPosition(lastAtSign);

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setAutocompletePosition({
        top: rect.bottom + window.scrollY + 4,
        left: rect.left + window.scrollX,
      });
    }
    setShowAutocomplete(true);
  }, []);

  const handleInput = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const nextValue = editor.readText();
    if (nextValue === knownTextRef.current) {
      // Clicking a badge fires input without changing anything.
      return;
    }

    // The browser has already drawn the keystroke. Redrawing is only needed
    // when the number of tokens changed, which means a badge has appeared or
    // been broken apart, and plain text has to become a badge or stop being
    // one. Redrawing on every keystroke would move the caret.
    const before = findTemplateTokens(knownTextRef.current).length;
    const after = findTemplateTokens(nextValue).length;

    knownTextRef.current = nextValue;
    onChange?.(nextValue);

    if (before === after) {
      syncAutocomplete(nextValue);
      return;
    }

    setShowAutocomplete(false);
    editor.render(nextValue, { focused: true, nodes, placeholder });
  }, [nodes, onChange, placeholder, syncAutocomplete]);

  const handleAutocompleteSelect = useCallback(
    (template: string) => {
      const editor = editorRef.current;
      if (!editor || atSignPosition === null) {
        return;
      }

      const currentText = editor.readText();
      const beforeAt = currentText.slice(0, atSignPosition);
      const afterFilter = currentText.slice(
        atSignPosition + 1 + autocompleteFilter.length
      );
      const nextValue = beforeAt + template + afterFilter;

      knownTextRef.current = nextValue;
      onChange?.(nextValue);

      setShowAutocomplete(false);
      setAtSignPosition(null);
      setIsFocused(true);

      // The caret belongs immediately after the badge just inserted, which is a
      // position in the new text rather than anywhere in the old DOM.
      editor.render(nextValue, {
        caretOffset: beforeAt.length + template.length,
        focused: true,
        nodes,
        placeholder,
      });
    },
    [atSignPosition, autocompleteFilter, nodes, onChange, placeholder]
  );

  const handleFocus = useCallback(() => {
    setIsFocused(true);

    // What the field holds is what the DOM holds, not what the last render's
    // prop said. Placing the caret can refocus the container, and reading the
    // prop there would redraw with a value that has not caught up yet.
    const currentText = editorRef.current?.readText() ?? value;
    knownTextRef.current = currentText;

    // Focusing swaps placeholder text for a caret, and that is the only thing
    // it changes. Redrawing a field that already has content would throw away
    // the caret position the click just established.
    if (!currentText) {
      editorRef.current?.render("", { focused: true, nodes, placeholder });
    }
  }, [nodes, value, placeholder]);

  const handleBlur = useCallback(() => {
    // Delayed so a click on an autocomplete option still counts as a selection.
    setTimeout(() => {
      if (document.activeElement === containerRef.current) {
        return;
      }
      setIsFocused(false);
      setShowAutocomplete(false);
    }, BLUR_GRACE_MS);
  }, []);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      event.preventDefault();
      if (editorRef.current?.insertText(event.clipboardData.getData("text/plain"))) {
        handleInput();
      }
    },
    [handleInput]
  );

  const insertLineBreak = useCallback(() => {
    if (editorRef.current?.insertLineBreak()) {
      handleInput();
    }
  }, [handleInput]);

  return {
    attachEditor,
    autocompleteFilter,
    autocompletePosition,
    handleBlur,
    handleFocus,
    handleInput,
    handleAutocompleteSelect,
    handlePaste,
    insertLineBreak,
    closeAutocomplete: useCallback(() => setShowAutocomplete(false), []),
    nodes,
    showAutocomplete,
  };
}

/** Frozen key: while focused, the handlers own the DOM, not React. */
const FOCUSED = Symbol("focused");

/** Long enough for a click on an autocomplete option to land first. */
const BLUR_GRACE_MS = 200;
