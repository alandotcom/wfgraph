import { useStore } from "jotai";
import { useCallback } from "react";
import { ConfigurationOverlay } from "#src/components/overlays/configuration-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import type { WorkspaceAddress } from "#src/lib/workflow-navigation-state";
import {
  activeWorkspaceAddressAtom,
  openMobileSelectionAtom,
} from "#src/lib/workflow-workspace-navigation";

/**
 * Open the inspector a narrow viewport shows for `address`, the active address
 * when none is named. A caller about to navigate names the address it goes to,
 * because the active address changes only once the route has synced. In Draft
 * with one object selected, that inspector is the object's summary sheet in the
 * mobile Reveal sequence, which the navigation state records; with a sheet
 * already open it changes nothing. Anywhere else it is the configuration sheet,
 * opened with the same `onClose` from every caller, so it cannot be dismissed
 * into a state nothing on screen explains.
 */
export function useConfigurationSheet(): {
  openSheet: (address?: WorkspaceAddress) => void;
} {
  const { open } = useOverlay();
  const store = useStore();

  const openSheet = useCallback(
    (address?: WorkspaceAddress) => {
      const target = address ?? store.get(activeWorkspaceAddressAtom);
      if (store.set(openMobileSelectionAtom, target)) {
        return;
      }
      open(ConfigurationOverlay, {});
    },
    [open, store]
  );

  return { openSheet };
}
