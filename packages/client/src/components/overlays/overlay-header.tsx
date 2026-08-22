import * as stylex from "@stylexjs/stylex";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChevronLeft, X } from "lucide-react";
import { useOverlay, useOverlayPosition } from "./overlay-provider";
import type { OverlayHeaderProps } from "./types";

export function OverlayHeader({
  title,
  description,
  showBackButton: showBackButtonProp,
  showCloseButton = true,
  onBack,
  onClose,
  overlayId,
}: OverlayHeaderProps & { overlayId?: string }) {
  const { pop, closeAll } = useOverlay();

  const showBackButton = showBackButtonProp ?? false;

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      pop();
    }
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else {
      closeAll();
    }
  };

  return (
    <VStack gap={1.5} padding={6} paddingBlock={6} xstyle={styles.header}>
      <HStack align="center" gap={2} minHeight={32}>
        {showBackButton && (
          <IconButton
            icon={<Icon icon={ChevronLeft} size="sm" />}
            label="Go back"
            onClick={handleBack}
            variant="ghost"
          />
        )}
        {title && (
          <Heading
            id={overlayId ? `overlay-title-${overlayId}` : undefined}
            level={2}
            xstyle={styles.title}
          >
            {title}
          </Heading>
        )}
        {showCloseButton && (
          <IconButton
            icon={<Icon icon={X} size="sm" />}
            label="Close"
            onClick={handleClose}
            variant="ghost"
          />
        )}
      </HStack>
      {description && <Text color="secondary">{description}</Text>}
    </VStack>
  );
}

const styles = stylex.create({
  header: {
    paddingBlockEnd: 0,
  },
  title: {
    flex: 1,
  },
});

/** Back button follows stack depth unless the caller overrides it. */
export function SmartOverlayHeader({
  overlayId,
  showBackButton: showBackButtonProp,
  ...props
}: OverlayHeaderProps & { overlayId: string }) {
  const { showBackButton: stackShowBackButton } = useOverlayPosition(overlayId);

  return (
    <OverlayHeader
      {...props}
      overlayId={overlayId}
      showBackButton={showBackButtonProp ?? stackShowBackButton}
    />
  );
}
