import type { RefObject } from "react";
import {
  workspaceAddressId,
  type WorkspaceAddress,
} from "#src/lib/workflow-navigation-state";
import { mobileSheetKey } from "#src/lib/mobile-sheet-navigation";
import type { MobileRevealState } from "./canvas-reveal-state";
import { useInspectorScroll } from "./use-inspector-scroll";
import { useMobileSheetScroll } from "./use-mobile-sheet-scroll";

/**
 * Keeps the scroll of a body that shows an address itself, such as a run list
 * or a run's overview, for a kind that scrolls inside its own body. In Canvas
 * Reveal the position is the address's Browse scroll; in the mobile Reveal
 * sequence it is the scroll of the address sheet, the first sheet. `address` is
 * null while the body's scroller is hidden, and `mobile` is the sheet the body
 * shows on, which `RevealBodyProps.mobile` carries.
 */
export function useAddressBodyScroll(
  address: WorkspaceAddress | null,
  mobile: MobileRevealState | null
): {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onScrollEnd: () => void;
  adoptScroll: () => void;
} {
  const onSheet = mobile !== null && mobile.sheet.inspected === null;
  const addressId = address ? workspaceAddressId(address) : null;
  const desktop = useInspectorScroll(
    address && addressId && mobile === null
      ? { address, addressId, inspectedId: null, level: "browse" }
      : null
  );
  const sheet = useMobileSheetScroll(
    address && addressId && onSheet
      ? {
          address,
          sheetKey: mobileSheetKey({
            addressId,
            depth: 1,
            level: "summary",
            inspected: null,
          }),
          depth: 1,
          level: "summary",
          inspected: null,
        }
      : null
  );
  return mobile === null ? desktop : sheet;
}
