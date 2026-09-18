import { useStore } from "jotai";
import type { MobileRevealLevel } from "#src/lib/mobile-sheet-navigation";
import {
  type InspectedObject,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { sameObject } from "#src/lib/canvas-selection";
import { recordMobileSheetScrollAtom } from "#src/lib/mobile-sheet-store";
import { activeMobileSheetsAtom } from "#src/lib/workflow-workspace-navigation";
import { useKeptScroll } from "./use-kept-scroll";

/**
 * Keeps the scroll of each mobile Reveal sheet in that sheet's navigation
 * state. `sheetKey` is the sheet's `mobileSheetKey`. Each write names the
 * sheet's depth, level and object, so it never lands on a different sheet.
 * `input` is null while no sheet shows.
 */
export function useMobileSheetScroll(
  input: {
    address: WorkspaceAddress;
    sheetKey: string;
    depth: number;
    level: MobileRevealLevel;
    inspected: InspectedObject | null;
  } | null
): ReturnType<typeof useKeptScroll> {
  const store = useStore();
  return useKeptScroll(
    input && {
      key: input.sheetKey,
      readTop: () => {
        const sheet = store.get(activeMobileSheetsAtom).at(input.depth - 1);
        return sheet &&
          sheet.level === input.level &&
          sameObject(sheet.inspected, input.inspected)
          ? sheet.scroll
          : 0;
      },
      record: (top) =>
        store.set(recordMobileSheetScrollAtom, {
          address: input.address,
          depth: input.depth,
          level: input.level,
          inspected: input.inspected,
          top,
        }),
    }
  );
}
