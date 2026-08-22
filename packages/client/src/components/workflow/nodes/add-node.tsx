import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import type { NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";

type AddNodeData = { onClick?: () => void };

export function AddNode({ data }: NodeProps & { data?: AddNodeData }) {
  return (
    <div {...stylex.props(styles.container)}>
      <Button
        icon={<Icon icon={Plus} size="sm" />}
        label="Add a step"
        onClick={data.onClick}
        variant="primary"
      />
    </div>
  );
}

const styles = stylex.create({
  container: {
    alignItems: "center",
    backgroundColor: colorVars["--color-background-card"],
    border: `1px dashed ${colorVars["--color-border"]}`,
    borderRadius: 8,
    display: "flex",
    justifyContent: "center",
    padding: spacingVars["--spacing-6"],
  },
});
