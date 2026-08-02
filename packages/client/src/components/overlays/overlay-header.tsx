import { ChevronLeftIcon, XIcon } from "lucide-react";
import { Button } from "#src/components/ui/button";
import { cn } from "@rova/shared/utils";
import { useOverlay, useOverlayPosition } from "./overlay-provider";
import type { OverlayHeaderProps } from "./types";

export function OverlayHeader({
  title,
  description,
  showBackButton: showBackButtonProp,
  showCloseButton = true,
  onBack,
  onClose,
  className,
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
    <div className={cn("relative flex flex-col gap-1.5 p-6 pb-0", className)}>
      {/* Fixed min-height to prevent layout shift when back button appears */}
      <div className="flex min-h-8 items-center gap-2">
        {showBackButton && (
          <Button
            aria-label="Go back"
            className="ml-[-8px] size-8 shrink-0"
            onClick={handleBack}
            size="icon"
            variant="ghost"
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        {title && (
          <h2 className="flex-1 font-semibold text-lg leading-none tracking-tight">
            {title}
          </h2>
        )}
        {showCloseButton && (
          <Button
            aria-label="Close"
            className="absolute top-4 right-4 size-8 shrink-0 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onClick={handleClose}
            size="icon"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        )}
      </div>
      {description && (
        <p className="text-muted-foreground text-sm">{description}</p>
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
      showBackButton={showBackButtonProp ?? stackShowBackButton}
    />
  );
}
