import { useStore } from "jotai";
import { type RefObject, useRef } from "react";
import {
  useAfterPaint,
  useBeforePaint,
  useUnmountCleanup,
} from "#src/hooks/effects";
import type {
  OpenRevealLevel,
  WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import {
  activeRevealPresentationAtom,
  recordInspectorScrollAtom,
} from "#src/lib/workflow-workspace-navigation";

type Shown = {
  address: WorkspaceAddress;
  inspectedId: string | null;
  level: OpenRevealLevel;
  top: number;
};

/**
 * Keeps an inspector's scroll position in the scope's navigation state. The
 * position is read on every scroll and written when scrolling ends, when the
 * address, object, or level changes, and on unmount. A new address, object, or
 * level restores its stored position before paint, and once more after paint
 * for content that mounted late. `input` is null while no such level is open.
 * A null `inspectedId` keeps the scroll of a scope that inspects no object. A
 * kind whose subjects never record `inspected`, such as Changes, passes null,
 * so its body scroll is stored under a null inspected id whatever it selects.
 */
export function useInspectorScroll(
  input: {
    address: WorkspaceAddress;
    addressId: string;
    inspectedId: string | null;
    level: OpenRevealLevel;
  } | null
): {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onScrollEnd: () => void;
  /**
   * Take the body's current scroll as the position to keep, after something
   * other than the person scrolled it, such as focusing a field.
   */
  adoptScroll: () => void;
} {
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const shownRef = useRef<Shown | null>(null);
  const key = input
    ? `${input.addressId}|${input.inspectedId ?? ""}|${input.level}`
    : null;

  const record = () => {
    const current = shownRef.current;
    if (current) {
      store.set(recordInspectorScrollAtom, current);
    }
  };

  useBeforePaint(key, () => {
    record();
    if (!input) {
      shownRef.current = null;
      return;
    }
    const presentation = store.get(activeRevealPresentationAtom);
    const top =
      (presentation.inspected?.id ?? null) === input.inspectedId
        ? presentation.inspectorScroll[input.level]
        : 0;
    shownRef.current = {
      address: input.address,
      inspectedId: input.inspectedId,
      level: input.level,
      top,
    };
    if (ref.current) {
      ref.current.scrollTop = top;
    }
  });

  useAfterPaint(key, () => {
    const current = shownRef.current;
    if (current && ref.current && ref.current.scrollTop !== current.top) {
      ref.current.scrollTop = current.top;
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
  };
}
