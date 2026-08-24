import { useCallback } from "react";
import { ConfigurationOverlay } from "#src/components/overlays/configuration-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";

/**
 * Open the node config sheet, which is how a narrow viewport reaches the config
 * panel. Every caller goes through here so the sheet is opened with the same
 * `onClose` and cannot be dismissed into a state nothing on screen explains.
 *
 * `openSheet` replaces the stack; `pushSheet` stacks on top so the overlay below
 * keeps its Back button.
 */
export function useConfigurationSheet(): {
  openSheet: () => void;
  pushSheet: () => void;
} {
  const { open, push } = useOverlay();

  const openSheet = useCallback(() => {
    open(ConfigurationOverlay, {});
  }, [open]);

  const pushSheet = useCallback(() => {
    push(ConfigurationOverlay, {});
  }, [push]);

  return { openSheet, pushSheet };
}
