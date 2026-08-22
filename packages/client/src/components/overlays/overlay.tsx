import { VStack } from "@astryxdesign/core/VStack";
import { OverlayFooter } from "./overlay-footer";
import { SmartOverlayHeader } from "./overlay-header";
import type { OverlayProps } from "./types";

type OverlayComponentProps = OverlayProps & {
  /** The overlay's unique ID (passed automatically by the container) */
  overlayId: string;
};

/**
 * Base Overlay component for creating new overlays.
 * Provides consistent structure with header, content area, and footer.
 *
 * @example
 * ```tsx
 * function SettingsOverlay({ overlayId }: { overlayId: string }) {
 *   const { pop } = useOverlay();
 *
 *   return (
 *     <Overlay
 *       overlayId={overlayId}
 *       title="Settings"
 *       description="Manage your preferences"
 *       actions={[
 *         { label: "Cancel", variant: "secondary", onClick: pop },
 *         { label: "Save", onClick: handleSave },
 *       ]}
 *     >
 *       <SettingsContent />
 *     </Overlay>
 *   );
 * }
 * ```
 */
export function Overlay({
  overlayId,
  title,
  description,
  actions,
  children,
}: OverlayComponentProps) {
  return (
    <VStack minHeight={0} xstyle={styles.overlay}>
      {/* Header with smart back button detection */}
      {(title || description) && (
        <SmartOverlayHeader
          description={description}
          overlayId={overlayId}
          title={title}
        />
      )}

      {/* Content area. `min-h-0` lets this scroll inside a height-capped card
          rather than pushing the footer actions off the bottom of the screen. */}
      {children && (
        <VStack isScrollable minHeight={0} padding={6} xstyle={styles.content}>
          {children}
        </VStack>
      )}

      {/* Footer with actions */}
      <OverlayFooter actions={actions} />
    </VStack>
  );
}

import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  overlay: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});
