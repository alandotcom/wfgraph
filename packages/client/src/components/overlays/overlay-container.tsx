import * as stylex from "@stylexjs/stylex";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Dialog } from "@astryxdesign/core/Dialog";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useIsMobile } from "#src/hooks/use-mobile";
import { useOverlay } from "./overlay-provider";
import type { OverlayOptions } from "./types";

const spring = {
  type: "spring",
  stiffness: 400,
  damping: 35,
  mass: 0.8,
} as const;

function getOverlayXPosition(
  isCurrent: boolean,
  isPrevious: boolean
): "0%" | "-35%" | "100%" {
  if (isCurrent) {
    return "0%";
  }
  return isPrevious ? "-35%" : "100%";
}

function getPurpose(
  options: OverlayOptions | undefined
): "form" | "info" | "required" {
  if (options?.closeOnEscape === false) {
    return "required";
  }
  if (options?.closeOnBackdropClick === false) {
    return "form";
  }
  return "info";
}

function OverlayStack() {
  const { stack } = useOverlay();
  const shouldReduceMotion = useReducedMotion();
  const currentIndex = stack.length - 1;
  const transition = shouldReduceMotion ? { duration: 0.01 } : spring;

  return (
    <LayoutGroup>
      <div {...stylex.props(styles.stack)}>
        {stack.map((item, index) => {
          const isCurrent = index === currentIndex;
          const isPrevious = index < currentIndex;
          const shouldSlideIn = isCurrent && stack.length > 1;

          return (
            <motion.div
              animate={{
                x: getOverlayXPosition(isCurrent, isPrevious),
                scale: isCurrent ? 1 : 0.94,
                opacity: isCurrent ? 1 : 0,
              }}
              aria-hidden={!isCurrent}
              className={
                stylex.props(isCurrent ? styles.current : styles.inactive)
                  .className
              }
              initial={shouldSlideIn ? { x: "100%", opacity: 1 } : false}
              key={item.id}
              transition={transition}
            >
              <item.component overlayId={item.id} {...item.props} />
            </motion.div>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function DesktopOverlayContainer() {
  const { stack, closeAll, pop } = useOverlay();
  const currentItem = stack.at(-1);

  return (
    <Dialog
      aria-labelledby={
        currentItem ? `overlay-title-${currentItem.id}` : undefined
      }
      isOpen={stack.length > 0}
      maxHeight="calc(100dvh - 2rem)"
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          if (stack.length > 1) {
            pop();
          } else {
            closeAll();
          }
        }
      }}
      purpose={getPurpose(currentItem?.options)}
      width="min(32rem, calc(100vw - 2rem))"
    >
      <OverlayStack />
    </Dialog>
  );
}

function MobileOverlayContainer() {
  const { stack, closeAll, pop } = useOverlay();
  const currentItem = stack.at(-1);

  return (
    <BottomSheet
      height="tall"
      isOpen={stack.length > 0}
      label={currentItem?.options.title ?? "Workflow settings"}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          if (stack.length > 1) {
            pop();
          } else {
            closeAll();
          }
        }
      }}
      purpose={getPurpose(currentItem?.options)}
    >
      <OverlayStack />
    </BottomSheet>
  );
}

export function OverlayContainer() {
  return useIsMobile() ? (
    <MobileOverlayContainer />
  ) : (
    <DesktopOverlayContainer />
  );
}

const styles = stylex.create({
  stack: {
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
    width: "100%",
  },
  current: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    position: "relative",
    width: "100%",
  },
  inactive: {
    inset: 0,
    pointerEvents: "none",
    position: "absolute",
    width: "100%",
  },
});
