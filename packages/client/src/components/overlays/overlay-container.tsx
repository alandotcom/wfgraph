import type { Variants } from "motion/react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "motion/react";
import { useCallback, useRef } from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { Dialog, DialogPortal } from "#src/components/ui/dialog";
import {
  useDomEvent,
  useFocusTrap,
  useMeasuredHeight,
} from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { cn } from "@wfgraph/shared/utils";
import { useOverlay } from "./overlay-provider";

// iOS-like spring configuration
const iosSpring = {
  type: "spring",
  stiffness: 400,
  damping: 35,
  mass: 0.8,
} as const;

// Softer spring for drawer
const drawerSpring = {
  type: "spring",
  stiffness: 350,
  damping: 30,
  mass: 0.8,
} as const;

/**
 * Variants for the dialog container (fade in/out)
 */
const containerVariants: Variants = {
  hidden: {
    opacity: 0,
    transform: "translate(-50%, -50%) scale(0.95)",
  },
  visible: {
    opacity: 1,
    transform: "translate(-50%, -50%) scale(1)",
    transition: {
      type: "spring",
      stiffness: 400,
      damping: 30,
    },
  },
  exit: {
    opacity: 0,
    transform: "translate(-50%, -50%) scale(0.95)",
    transition: {
      duration: 0.15,
      ease: [0.23, 1, 0.32, 1],
    },
  },
};

const reducedContainerVariants: Variants = {
  hidden: {
    opacity: 0,
    transform: "translate(-50%, -50%) scale(1)",
  },
  visible: {
    opacity: 1,
    transform: "translate(-50%, -50%) scale(1)",
    transition: { duration: 0.1, ease: [0.23, 1, 0.32, 1] },
  },
  exit: {
    opacity: 0,
    transform: "translate(-50%, -50%) scale(1)",
    transition: { duration: 0.1, ease: [0.23, 1, 0.32, 1] },
  },
};

/**
 * Get x position for overlay item based on its position relative to current
 */
function getOverlayTransform(
  isCurrent: boolean,
  isPrevious: boolean,
  shouldReduceMotion: boolean
): string {
  if (shouldReduceMotion) {
    return "translateX(0%) scale(1)";
  }
  if (isCurrent) {
    return "translateX(0%) scale(1)";
  }
  if (isPrevious) {
    return "translateX(-35%) scale(0.94)";
  }
  return "translateX(100%) scale(1)";
}

/**
 * Desktop dialog container with internal sliding content
 * Renders all stack items persistently in the same React tree location,
 * using CSS transforms to animate visibility while preserving component state
 */
function DesktopOverlayContainer() {
  const { stack, closeAll, pop } = useOverlay();
  const shouldReduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const isOpen = stack.length > 0;

  const renderStack = stack;
  const currentIndex = renderStack.length - 1;

  // The dialog holds the height of whatever opened in it, so that a panel
  // swapping for a taller or shorter one animates between the two rather than
  // snapping.
  const minHeight = useMeasuredHeight(contentRef, isOpen);

  // Use live stack for options checks (only when open)
  const currentItem = stack.at(-1);
  const springTransition = shouldReduceMotion ? { duration: 0.01 } : iosSpring;

  const handleBackdropClick = useCallback(() => {
    if (currentItem?.options.closeOnBackdropClick !== false) {
      closeAll();
    }
  }, [currentItem?.options.closeOnBackdropClick, closeAll]);

  const handleEscapeKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && currentItem?.options.closeOnEscape !== false) {
        pop();
      }
    },
    [currentItem?.options.closeOnEscape, pop]
  );

  useDomEvent(document, "keydown", handleEscapeKey, { enabled: isOpen });
  useFocusTrap(dialogRef, isOpen);

  if (!isOpen) {
    return null;
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <Dialog modal={false} open>
          <DialogPortal keepMounted>
            {/* Backdrop - standalone clickable div */}
            <motion.div
              animate={{ opacity: 1 }}
              className="fixed inset-0 z-50 bg-foreground/60"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              onClick={handleBackdropClick}
              transition={{ duration: 0.2 }}
            />

            {/* Dialog container.
                This surface is a plain div rather than a mounted popup, so the
                dialog role, aria-modal and the focus trap are set here by hand;
                without them a screen reader was never told an overlay opened and
                Tab walked onto the canvas behind the backdrop. */}
            <motion.div
              animate="visible"
              aria-labelledby={
                currentItem ? `overlay-title-${currentItem.id}` : undefined
              }
              aria-modal="true"
              className="fixed top-1/2 left-1/2 z-50 w-full max-w-lg px-4"
              exit="exit"
              initial="hidden"
              ref={dialogRef}
              role="dialog"
              variants={
                shouldReduceMotion
                  ? reducedContainerVariants
                  : containerVariants
              }
            >
              <LayoutGroup>
                <motion.div
                  className="relative flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-xl border bg-card shadow-lg ring-1 ring-border"
                  layout={shouldReduceMotion ? false : "position"}
                  style={{ minHeight: minHeight > 0 ? minHeight : "auto" }}
                  transition={iosSpring}
                >
                  {/* Content area - all items rendered persistently to preserve state.
                      `min-h-0` is what lets the overlay's own scroller take over
                      once the content is taller than the viewport; without it the
                      card grew past the screen and clipped its footer actions. */}
                  <div
                    className="relative flex min-h-0 flex-1 flex-col"
                    ref={contentRef}
                  >
                    {renderStack.map((item, index) => {
                      const isCurrent = index === currentIndex;
                      const isPrevious = index < currentIndex;

                      // For push onto existing stack: new current item slides in from right
                      // For first overlay (fresh open): no slide, dialog container handles entrance
                      // For pop: returning item is already at -35%, animates to 0%
                      const shouldSlideIn = isCurrent && renderStack.length > 1;
                      const initialValue = shouldSlideIn
                        ? {
                            transform: shouldReduceMotion
                              ? "translateX(0%) scale(1)"
                              : "translateX(100%) scale(1)",
                            opacity: 1,
                          }
                        : false;

                      return (
                        <motion.div
                          animate={{
                            transform: getOverlayTransform(
                              isCurrent,
                              isPrevious,
                              shouldReduceMotion ?? false
                            ),
                            opacity: isCurrent ? 1 : 0,
                          }}
                          aria-hidden={!isCurrent}
                          className={cn(
                            "w-full",
                            isCurrent
                              ? "relative flex min-h-0 flex-col"
                              : "pointer-events-none absolute inset-0"
                          )}
                          initial={initialValue}
                          key={item.id}
                          transition={springTransition}
                        >
                          <item.component overlayId={item.id} {...item.props} />
                        </motion.div>
                      );
                    })}
                  </div>
                </motion.div>
              </LayoutGroup>
            </motion.div>
          </DialogPortal>
        </Dialog>
      )}
    </AnimatePresence>
  );
}

/**
 * Mobile drawer container with internal sliding content
 * Renders all stack items persistently in the same React tree location,
 * using CSS transforms to animate visibility while preserving component state
 */
function MobileOverlayContainer() {
  const { stack, closeAll, pop } = useOverlay();
  const shouldReduceMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);

  const isOpen = stack.length > 0;

  const renderStack = stack;
  const currentIndex = renderStack.length - 1;

  // The drawer holds the height of whatever opened in it, so that a panel
  // swapping for a taller or shorter one animates between the two rather than
  // snapping.
  const minHeight = useMeasuredHeight(contentRef, isOpen);

  // Use live stack for options checks (only when open)
  const currentItem = stack.at(-1);
  const springTransition = shouldReduceMotion ? { duration: 0.01 } : iosSpring;

  const handleEscapeKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && currentItem?.options.closeOnEscape !== false) {
        pop();
      }
    },
    [currentItem?.options.closeOnEscape, pop]
  );

  useDomEvent(document, "keydown", handleEscapeKey, { enabled: isOpen });

  return (
    <DrawerPrimitive.Root
      onOpenChange={(open) => {
        if (!open) {
          closeAll();
        }
      }}
      open={isOpen}
    >
      <DrawerPrimitive.Portal>
        {/* Base UI animates from CSS rather than from JS the way vaul did:
            `data-starting-style` is the frame the sheet enters from and
            `data-ending-style` the one it leaves to, and while a finger is on
            the sheet `--drawer-swipe-progress` (0 to 1) fades the backdrop out
            in step with the drag. */}
        <DrawerPrimitive.Backdrop className="fixed inset-0 z-50 bg-black opacity-[calc(0.6*(1-var(--drawer-swipe-progress)))] transition-opacity duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-swiping:duration-0 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] motion-reduce:transition-none" />

        {/* Viewport has no vaul counterpart and is not optional: it owns the
            swipe gesture and the touch scroll lock, and it is what holds the
            sheet against the bottom edge, so the sheet itself is a laid-out
            flex item rather than a fixed one. */}
        <DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
          <DrawerPrimitive.Popup
            aria-labelledby={
              currentItem ? `overlay-title-${currentItem.id}` : undefined
            }
            className={cn(
              "flex max-h-[90vh] w-full flex-col outline-none",
              "rounded-t-xl border-t bg-card shadow-lg",
              // The bottom inset the home indicator needs. This used to be a
              // spacer div classed `h-safe-area-inset-bottom`, which Tailwind
              // v4 compiles to nothing, so the inset was never applied.
              "pb-[env(safe-area-inset-bottom,0px)]",
              // Follows the finger during a swipe, and slides fully off screen
              // for the enter and exit frames. `--drawer-swipe-strength` is the
              // release velocity, so a fast flick leaves faster than a slow one.
              "[transform:translateY(var(--drawer-swipe-movement-y))] transition-transform duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
              "data-swiping:select-none data-starting-style:[transform:translateY(calc(100%+2px))] data-ending-style:[transform:translateY(calc(100%+2px))] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] motion-reduce:transition-none"
            )}
          >
            {/* Base UI requires a Title, and the overlays that render their own
              visible header already carry one with a stable id, which is what
              aria-labelledby above points at. This stays as the fallback for an
              overlay with no header of its own; it used to read the literal
              word "Dialog" to a screen reader even when a real title existed. */}
            <DrawerPrimitive.Title className="sr-only">
              {currentItem?.options.title || "Overlay"}
            </DrawerPrimitive.Title>

            {/* Drag handle */}
            <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/20" />

            {/* Content area with height animation */}
            <LayoutGroup>
              <motion.div
                className="relative flex-1 overflow-hidden"
                layout={shouldReduceMotion ? false : "position"}
                style={{ minHeight: minHeight > 0 ? minHeight : "auto" }}
                transition={drawerSpring}
              >
                {/* Content wrapper - all items rendered persistently to preserve state */}
                <div className="relative" ref={contentRef}>
                  {renderStack.map((item, index) => {
                    const isCurrent = index === currentIndex;
                    const isPrevious = index < currentIndex;

                    // For push onto existing stack: new current item slides in from right
                    // For first overlay (fresh open): no slide, drawer container handles entrance
                    // For pop: returning item is already at -35%, animates to 0%
                    const shouldSlideIn = isCurrent && renderStack.length > 1;
                    const initialValue = shouldSlideIn
                      ? {
                          transform: shouldReduceMotion
                            ? "translateX(0%) scale(1)"
                            : "translateX(100%) scale(1)",
                          opacity: 1,
                        }
                      : false;

                    return (
                      <motion.div
                        animate={{
                          transform: getOverlayTransform(
                            isCurrent,
                            isPrevious,
                            shouldReduceMotion ?? false
                          ),
                          opacity: isCurrent ? 1 : 0,
                        }}
                        aria-hidden={!isCurrent}
                        className={cn(
                          "w-full",
                          isCurrent
                            ? "relative"
                            : "pointer-events-none absolute inset-0"
                        )}
                        initial={initialValue}
                        key={item.id}
                        transition={springTransition}
                      >
                        <item.component overlayId={item.id} {...item.props} />
                      </motion.div>
                    );
                  })}
                </div>
              </motion.div>
            </LayoutGroup>
          </DrawerPrimitive.Popup>
        </DrawerPrimitive.Viewport>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}

/**
 * Container component that renders overlays.
 * Place this once at the app level (inside OverlayProvider).
 */
export function OverlayContainer() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileOverlayContainer />;
  }

  return <DesktopOverlayContainer />;
}
