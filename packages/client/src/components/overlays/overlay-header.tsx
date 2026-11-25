import { ChevronLeftIcon, XIcon } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { cn } from "@wfgraph/shared/utils";
import { useOverlay, useOverlayPosition } from "./overlay-provider";
import type { OverlayHeaderProps } from "./types";

export function OverlayHeader({
  title,
  description,
  showBackButton: showBackButtonProp,
  showCloseButton = true,
  onBack,
  onClose,
  trailing,
  className,
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
    // The header recipe of the shared dialog: 16px padding, a 14px/500 title,
    // a 12px description and a 24px close button in the corner.
    <div className={cn("relative flex flex-col gap-1 p-4 pb-0", className)}>
      {/* Fixed min-height to prevent layout shift when back button appears */}
      <div
        className={cn(
          "flex min-h-6 items-center gap-2",
          showCloseButton && "pr-8"
        )}
      >
        {showBackButton && (
          <Button
            aria-label="Go back"
            className="-ml-1.5 shrink-0"
            onClick={handleBack}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </Button>
        )}
        {title && (
          // The container points aria-labelledby here, so the id has to track
          // the overlay's own id rather than being generated per render.
          <h2
            className="flex-1 font-medium text-sm"
            id={overlayId ? `overlay-title-${overlayId}` : undefined}
          >
            {title}
          </h2>
        )}
        {trailing ? (
          <div className="flex shrink-0 items-center">{trailing}</div>
        ) : null}
        {showCloseButton && (
          <Button
            aria-label="Close"
            className="absolute top-2 right-2"
            onClick={handleClose}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        )}
      </div>
      {description && (
        <p className="text-muted-foreground text-xs/relaxed">{description}</p>
      )}
    </div>
  );
}

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
