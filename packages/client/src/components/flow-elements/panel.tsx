import * as stylex from "@stylexjs/stylex";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Panel as PanelPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";

type PanelProps = Omit<ComponentProps<typeof PanelPrimitive>, "className"> & { xstyle?: stylex.StyleXStyles };

export const Panel = ({ xstyle, ...props }: PanelProps) => (
  <PanelPrimitive {...stylex.props(styles.panel, xstyle)} {...props} />
);

const styles = stylex.create({
  panel: {
    backgroundColor: colorVars["--color-background-card"],
    border: `1px solid ${colorVars["--color-border"]}`,
    borderRadius: 8,
    margin: spacingVars["--spacing-4"],
    padding: spacingVars["--spacing-1"],
  },
});
