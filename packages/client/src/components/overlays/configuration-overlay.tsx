import { useMemo } from "react";
import { ConfirmOverlay } from "#src/components/overlays/confirm-overlay";
import { SmartOverlayHeader } from "#src/components/overlays/overlay-header";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import {
  type NodeConfigFrame,
  NodeConfigPanel,
  useNodeConfigTitle,
} from "#src/components/workflow/node-config-panel";
import { useAfterCommit } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import type { OverlayComponentProps } from "./types";

type ConfigurationOverlayProps = OverlayComponentProps;

/**
 * The node config panel as a sheet, which is how a narrow viewport reaches it.
 * Everything on screen below the header is the same component Canvas Reveal
 * mounts; this file is the frame around it: a confirmation is another
 * overlay pushed on the stack, and the sheet can close itself once what it
 * was configuring is gone.
 *
 * The sheet exists only while Canvas Reveal does not, so one surface edits a
 * node at any width. Widening the window past the `md` breakpoint, where
 * Canvas Reveal mounts, dismisses the sheet.
 */
export function ConfigurationOverlay({ overlayId }: ConfigurationOverlayProps) {
  const { push, closeAll } = useOverlay();
  const title = useNodeConfigTitle();
  const isMobile = useIsMobile();

  useAfterCommit(isMobile, () => {
    if (!isMobile) {
      closeAll();
    }
  });

  const frame = useMemo<NodeConfigFrame>(
    () => ({
      confirm: ({ title: confirmTitle, message, confirmLabel, onConfirm }) =>
        push(ConfirmOverlay, {
          title: confirmTitle,
          message,
          confirmLabel,
          confirmVariant: "destructive" as const,
          destructive: true,
          onConfirm,
        }),
      dismiss: closeAll,
    }),
    [push, closeAll]
  );

  return (
    <div className="flex h-full max-h-[80vh] flex-col">
      <SmartOverlayHeader overlayId={overlayId} title={title} />
      <NodeConfigPanel frame={frame} />
    </div>
  );
}
