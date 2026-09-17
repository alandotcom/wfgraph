import { useStore } from "jotai";
import { type RefObject, useRef } from "react";
import {
  useAfterPaint,
  useBeforePaint,
  useUnmountCleanup,
} from "#src/hooks/effects";
import {
  sheetObjectKey,
  type MobileRevealLevel,
} from "#src/lib/mobile-sheet-navigation";
import {
  type InspectedObject,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { sameObject } from "#src/lib/canvas-selection";
import {
  activeMobileSheetsAtom,
  recordMobileSheetScrollAtom,
} from "#src/lib/workflow-workspace-navigation";

type ShownSheet = {
  address: WorkspaceAddress;
  depth: number;
  level: MobileRevealLevel;
  inspected: InspectedObject | null;
  top: number;
};

/**
 * Keeps the scroll of each mobile Reveal sheet in that sheet's navigation
 * state. The position is read on every scroll and written when scrolling
 * ends, when another sheet shows, and on unmount; each write names the sheet's
 * depth, level and object, so it never lands on a different sheet. A sheet
 * that shows restores its stored position before paint, and again after paint
 * for content that mounted late. `input` is null while no sheet shows.
 */
export function useMobileSheetScroll(
  input: {
    address: WorkspaceAddress;
    addressId: string;
    depth: number;
    level: MobileRevealLevel;
    inspected: InspectedObject | null;
  } | null
): {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onScrollEnd: () => void;
  /** Keep the body's current scroll, after a field took focus and scrolled it. */
  adoptScroll: () => void;
  /** Scroll the body to its top, for a body that shows another section. */
  scrollToTop: () => void;
} {
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const shownRef = useRef<ShownSheet | null>(null);
  const key = input
    ? `${input.addressId}|${input.depth}|${input.level}|${sheetObjectKey(input.inspected)}`
    : null;

  const record = () => {
    const shown = shownRef.current;
    if (shown) {
      store.set(recordMobileSheetScrollAtom, shown);
    }
  };

  useBeforePaint(key, () => {
    record();
    if (!input) {
      shownRef.current = null;
      return;
    }
    const sheet = store.get(activeMobileSheetsAtom).at(input.depth - 1);
    const top =
      sheet &&
      sheet.level === input.level &&
      sameObject(sheet.inspected, input.inspected)
        ? sheet.scroll
        : 0;
    shownRef.current = {
      address: input.address,
      depth: input.depth,
      level: input.level,
      inspected: input.inspected,
      top,
    };
    if (ref.current) {
      ref.current.scrollTop = top;
    }
  });

  useAfterPaint(key, () => {
    const shown = shownRef.current;
    if (shown && ref.current && ref.current.scrollTop !== shown.top) {
      ref.current.scrollTop = shown.top;
    }
  });

  useUnmountCleanup(record);

  const readScroll = () => {
    if (shownRef.current && ref.current) {
      shownRef.current = { ...shownRef.current, top: ref.current.scrollTop };
    }
  };

  return {
    ref,
    onScroll: readScroll,
    onScrollEnd: record,
    adoptScroll: () => {
      readScroll();
      record();
    },
    scrollToTop: () => {
      if (ref.current) {
        ref.current.scrollTop = 0;
      }
      readScroll();
    },
  };
}
