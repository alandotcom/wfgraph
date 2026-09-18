import { type RefObject, useRef } from "react";
import {
  useAfterPaint,
  useBeforePaint,
  useUnmountCleanup,
} from "#src/hooks/effects";

type Shown = { record: (top: number) => void; top: number };

/**
 * Keeps a scroller's position in navigation state. `key` names what the
 * scroller shows; a new key restores `readTop()` before paint and once more after
 * paint for content that mounted late. The position is read on every scroll and
 * handed to the `record` of the key it was read under when scrolling ends, when
 * the key changes, and on unmount. `input` is null while nothing is kept.
 */
export function useKeptScroll(
  input: {
    key: string;
    readTop: () => number;
    record: (top: number) => void;
  } | null
): {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onScrollEnd: () => void;
  /**
   * Take the scroller's current position as the one to keep, after something
   * other than the person scrolled it, such as focusing a field.
   */
  adoptScroll: () => void;
  /**
   * Scroll to the top, for a body whose navigation state already holds a top
   * scroll, such as a sectioned inspector showing another section. It writes
   * nothing to that state.
   */
  scrollToTop: () => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const shownRef = useRef<Shown | null>(null);

  const record = () => {
    const shown = shownRef.current;
    if (shown) {
      shown.record(shown.top);
    }
  };

  useBeforePaint(input?.key ?? null, () => {
    record();
    if (!input) {
      shownRef.current = null;
      return;
    }
    const top = input.readTop();
    shownRef.current = { record: input.record, top };
    if (ref.current) {
      ref.current.scrollTop = top;
    }
  });

  useAfterPaint(input?.key ?? null, () => {
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
