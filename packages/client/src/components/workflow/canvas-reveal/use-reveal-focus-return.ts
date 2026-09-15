import { type RefObject, useRef } from "react";
import { useBeforePaint } from "#src/hooks/effects";
import type { RevealLevel } from "#src/lib/workflow-navigation-state";

type Shown = {
  addressId: string;
  subjectKey: string | null;
  level: RevealLevel;
};

/**
 * Moves DOM focus with each Canvas Reveal level change. Opening Reveal, or a new
 * subject while open, records the focused element outside Reveal as the opener.
 * Focus takes focus to the title, and returning to Browse puts it on the Focus
 * toggle. A close that `returnFocusOnClose` marked hands focus back to the
 * opener, or to `fallbackTarget` once the opener has left the document.
 */
export function useRevealFocusReturn(input: {
  addressId: string;
  subjectKey: string | null;
  level: RevealLevel;
  aside: RefObject<HTMLElement | null>;
  title: RefObject<HTMLHeadingElement | null>;
  focusToggle: RefObject<HTMLButtonElement | null>;
  fallbackTarget: () => HTMLElement | null;
}): { returnFocusOnClose: () => void } {
  const shownRef = useRef<Shown>({
    addressId: input.addressId,
    subjectKey: input.subjectKey,
    level: input.level,
  });
  const openerRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef(false);

  useBeforePaint(
    `${input.addressId}|${input.subjectKey}|${input.level}`,
    () => {
      const shown = shownRef.current;
      const { addressId, subjectKey, level } = input;
      shownRef.current = { addressId, subjectKey, level };
      if (shown.addressId !== addressId) {
        openerRef.current = null;
        returnFocusRef.current = false;
        return;
      }
      if (
        level !== "closed" &&
        (shown.level === "closed" || shown.subjectKey !== subjectKey)
      ) {
        const active = document.activeElement;
        openerRef.current =
          active instanceof HTMLElement &&
          active !== document.body &&
          !input.aside.current?.contains(active)
            ? active
            : null;
      }
      if (level === "focus" && shown.level !== "focus") {
        input.title.current?.focus();
      }
      if (level === "browse" && shown.level === "focus") {
        input.focusToggle.current?.focus();
      }
      if (level === "closed" && returnFocusRef.current) {
        returnFocusRef.current = false;
        const opener = openerRef.current;
        (opener?.isConnected ? opener : input.fallbackTarget())?.focus();
      }
    }
  );

  return {
    returnFocusOnClose: () => {
      returnFocusRef.current = true;
    },
  };
}
