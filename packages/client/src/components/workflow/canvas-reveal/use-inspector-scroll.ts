import { useStore } from "jotai";
import type {
  RevealLevel,
  WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import {
  activeRevealPresentationAtom,
  recordInspectorScrollAtom,
} from "#src/lib/workflow-workspace-navigation";
import { useKeptScroll } from "./use-kept-scroll";

/**
 * Keeps a details column body's scroll in the scope's desktop presentation,
 * per address, inspected object, and level. `input` is null while the body
 * keeps no such scroll. A null `inspectedId` keeps the scroll of an address
 * that inspects no object, which is how Runs stores its body scroll whatever
 * it selects.
 */
export function useInspectorScroll(
  input: {
    address: WorkspaceAddress;
    addressId: string;
    inspectedId: string | null;
    level: RevealLevel;
  } | null
): ReturnType<typeof useKeptScroll> {
  const store = useStore();
  return useKeptScroll(
    input && {
      key: `${input.addressId}|${input.inspectedId ?? ""}|${input.level}`,
      readTop: () => {
        const presentation = store.get(activeRevealPresentationAtom);
        return (presentation.inspected?.id ?? null) === input.inspectedId
          ? presentation.inspectorScroll[input.level]
          : 0;
      },
      record: (top) =>
        store.set(recordInspectorScrollAtom, {
          address: input.address,
          inspectedId: input.inspectedId,
          level: input.level,
          top,
        }),
    }
  );
}
