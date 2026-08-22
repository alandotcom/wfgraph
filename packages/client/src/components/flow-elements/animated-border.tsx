import * as stylex from "@stylexjs/stylex";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";

const sweep = stylex.keyframes({
  from: { strokeDashoffset: 80 },
  to: { strokeDashoffset: 0 },
});

export const AnimatedBorder = () => (
  <>
    <svg aria-hidden {...stylex.props(styles.sweep)} xmlns="http://www.w3.org/2000/svg">
      <rect fill="none" height="calc(100% - 2px)" rx="6" stroke="currentColor" strokeDasharray="8 8" strokeWidth="2" width="calc(100% - 2px)" x="1" y="1" />
    </svg>
    <span aria-hidden {...stylex.props(styles.resting)} />
  </>
);

const styles = stylex.create({
  sweep: {
    animationDuration: "800ms",
    animationIterationCount: "infinite",
    animationName: sweep,
    animationTimingFunction: "linear",
    color: colorVars["--color-accent"],
    inset: 0,
    overflow: "visible",
    pointerEvents: "none",
    position: "absolute",
    width: "100%",
  },
  resting: {
    borderColor: colorVars["--color-accent-muted"],
    borderRadius: "inherit",
    borderStyle: "solid",
    borderWidth: 2,
    inset: 0,
    pointerEvents: "none",
    position: "absolute",
  },
});
