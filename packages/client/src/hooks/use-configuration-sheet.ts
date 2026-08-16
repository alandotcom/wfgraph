import { useCallback } from "react";
import { ConfigurationOverlay } from "#src/components/overlays/configuration-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useLeaveRunsSurface } from "#src/hooks/use-exit-run";
import { isMobileViewport } from "#src/hooks/use-mobile";

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
  const leaveRunsSurface = useLeaveRunsSurface();

  // The sheet carries the Runs tab, so closing it hides the only surface a
  // narrow viewport has for the open run. Without this the run stayed pinned to
  // the canvas and `canvasEditingLockedAtom` refused every edit, with no panel
  // left to say why (#96). The provider fires this from every path that takes
  // an overlay off the stack, so the header button, Escape, the backdrop, the
  // drawer's own dismiss and another overlay opening over the top are all
  // covered without an unmount effect.
  const onClose = useCallback(() => {
    // Widening past the breakpoint also closes the sheet, and there a rail has
    // taken the same run over, so the run stays. Sampled here rather than read
    // from `useIsMobile` at render: the viewport has already changed by the time
    // this runs, which is exactly the answer wanted.
    if (isMobileViewport()) {
      leaveRunsSurface();
    }
  }, [leaveRunsSurface]);

  const openSheet = useCallback(() => {
    open(ConfigurationOverlay, {}, { onClose });
  }, [open, onClose]);

  const pushSheet = useCallback(() => {
    push(ConfigurationOverlay, {}, { onClose });
  }, [push, onClose]);

  return { openSheet, pushSheet };
}
