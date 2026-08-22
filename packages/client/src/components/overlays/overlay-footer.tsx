import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import type { OverlayAction, OverlayFooterProps } from "./types";

/**
 * Render a single action button
 */
function ActionButton({ action }: { action: OverlayAction }) {
  return (
    <Button
      isDisabled={action.disabled}
      isLoading={action.loading}
      label={action.label}
      onClick={action.onClick}
      variant={toButtonVariant(action.variant)}
    />
  );
}

function toButtonVariant(
  variant: OverlayAction["variant"]
): "destructive" | "ghost" | "primary" | "secondary" {
  if (variant === "destructive") {
    return "destructive";
  }
  if (variant === "ghost") {
    return "ghost";
  }
  if (variant === "secondary") {
    return "secondary";
  }
  return "primary";
}

/**
 * Standardized footer component for overlays.
 * Renders action buttons in a consistent layout.
 */
export function OverlayFooter({ actions, children }: OverlayFooterProps) {
  // If children are provided, render them directly
  if (children) {
    return (
      <HStack gap={2} justify="end" padding={6}>
        {children}
      </HStack>
    );
  }

  // If no actions, render nothing
  if (!actions || actions.length === 0) {
    return null;
  }

  // Ghost buttons go on the left (additional actions like Delete)
  const leftActions = actions.filter((a) => a.variant === "ghost");

  // Right side: secondary then primary/destructive.
  const rightSecondary = actions.filter((a) => a.variant === "secondary");
  const rightPrimary = actions.filter(
    (a) => !a.variant || a.variant === "primary" || a.variant === "destructive"
  );

  const hasLeftActions = leftActions.length > 0;
  const hasRightActions = rightSecondary.length > 0 || rightPrimary.length > 0;

  return (
    <HStack
      gap={2}
      justify={hasLeftActions && hasRightActions ? "between" : "end"}
      padding={6}
      wrap="wrap"
    >
      {/* Ghost actions on the left */}
      {hasLeftActions && (
        <HStack gap={2} wrap="wrap">
          {leftActions.map((action) => (
            <ActionButton action={action} key={action.label} />
          ))}
        </HStack>
      )}

      {/* Secondary + Primary actions on the right: [secondary] [primary] */}
      {hasRightActions && (
        <HStack gap={2} wrap="wrap">
          {rightSecondary.map((action) => (
            <ActionButton action={action} key={action.label} />
          ))}
          {rightPrimary.map((action) => (
            <ActionButton action={action} key={action.label} />
          ))}
        </HStack>
      )}
    </HStack>
  );
}
