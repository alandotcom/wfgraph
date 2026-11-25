/**
 * One Tab stop for a list of rows, with the keys Linear's lists use: Down or J
 * and Up or K move between rows, Home and End jump to the ends, Enter opens
 * the row, Space toggles its selection, and Shift+F10 or the context-menu key
 * opens its actions. The controls inside a row take `tabIndex={-1}`, so Tab
 * leaves the list in one press.
 *
 * Each row carries `data-row-index`, which is how a key finds the row it moves
 * to. A virtualized list passes `reveal`, which scrolls a row that is not
 * rendered yet into the list, and focus follows on the next frame.
 */

import {
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useState,
} from "react";

/** The row a key moves to from `index`, or null for a key that moves nothing. */
export function rowKeyTarget(
  key: string,
  index: number,
  count: number
): number | null {
  switch (key) {
    case "ArrowDown":
    case "j":
      return Math.min(index + 1, count - 1);
    case "ArrowUp":
    case "k":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

type RowKeyActions = {
  open: (index: number) => void;
  /** Space. Absent where the rows cannot be selected. */
  toggle?: ((index: number) => void) | undefined;
  /** Shift+F10 or the context-menu key. Absent where rows have no menu. */
  openMenu?: ((index: number) => void) | undefined;
  /** Bring a row that is not rendered into the list. */
  reveal?: ((index: number) => void) | undefined;
};

type RowKeyProps = {
  "data-row-index": number;
  tabIndex: number;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

export function useListRowKeys(input: {
  count: number;
  /** The element holding every row, which a key searches for the next row. */
  container: RefObject<HTMLElement | null>;
  actions: RowKeyActions;
}): (index: number) => RowKeyProps {
  const { count, container, actions } = input;
  const [active, setActive] = useState(0);
  // The row that takes Tab, held inside the list when rows go away.
  const tabStop = Math.max(0, Math.min(active, count - 1));

  const rowAt = (index: number) =>
    container.current?.querySelector<HTMLElement>(
      `[data-row-index="${index}"]`
    ) ?? null;

  const moveTo = (index: number) => {
    setActive(index);
    const row = rowAt(index);
    if (row) {
      row.focus();
      row.scrollIntoView?.({ block: "nearest" });
      return;
    }
    actions.reveal?.(index);
    requestAnimationFrame(() => rowAt(index)?.focus());
  };

  return (index) => ({
    "data-row-index": index,
    tabIndex: index === tabStop ? 0 : -1,
    // A click on a control inside the row makes that row the Tab stop too.
    onFocus: () => setActive(index),
    onKeyDown: (event) => {
      // Keys typed into a control inside the row, such as an open menu's
      // trigger, belong to that control.
      if (
        event.target !== event.currentTarget ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (
        event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)
      ) {
        if (actions.openMenu) {
          event.preventDefault();
          actions.openMenu(index);
        }
        return;
      }
      if (event.shiftKey) {
        return;
      }
      const next = rowKeyTarget(event.key, index, count);
      if (next !== null) {
        event.preventDefault();
        moveTo(next);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        actions.open(index);
        return;
      }
      if (event.key === " " && actions.toggle) {
        event.preventDefault();
        actions.toggle(index);
      }
    },
  });
}
